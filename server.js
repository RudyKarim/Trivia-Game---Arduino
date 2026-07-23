// ============================================================
// TRIVIA GAME — Node.js backend server
// ------------------------------------------------------------
// This file is the brain of the entire game.
// It does three things at once:
//
//   1. Talks to the Arduino over USB (serial port)
//      Reads button presses, sends LED commands back.
//
//   2. Runs a WebSocket server on port 8080
//      The browser (page.js) connects here to receive
//      game events and send answer selections.
//
//   3. Serves the static HTML/CSS/JS files on port 3000
//      So you just open http://localhost:3000 in a browser —
//      no separate web server needed.
//
// HOW TO RUN:
//   1. npm install
//   2. node server.js
//   3. Open http://localhost:3000 in your browser
//
// SERIAL PORT:
//   Change SERIAL_PORT below to match your Arduino's port.
//   On Windows it will be something like 'COM3' or 'COM5'.
//   On Mac/Linux it will be '/dev/ttyUSB0' or '/dev/ttyACM0'.
//   You can find the right port in the Arduino IDE under
//   Tools → Port.
// ============================================================

'use strict';

// ── IMPORTS ──────────────────────────────────────────────────

// 'path' is built into Node.js — no install needed.
// We use it to safely build file paths that work on any OS.
const path = require('path');

// 'fs' is also built-in. We use it to read the Excel file.
const fs = require('fs');

// 'http' is built-in. We use it to serve the web page.
const http = require('http');

// 'xlsx' reads Excel files (.xlsx). Already in your package.json.
const XLSX = require('xlsx');

// 'ws' is the WebSocket library. Run: npm install ws
const { WebSocketServer, WebSocket } = require('ws');

// 'serialport' talks to the Arduino over USB.
// Run: npm install serialport
const { SerialPort } = require('serialport');

// 'ReadlineParser' splits the incoming serial data into lines.
// The Arduino sends one message per line (ending with \n).
// Without this, we'd get random chunks of bytes.
const { ReadlineParser } = require('@serialport/parser-readline');


// ── CONFIGURATION ─────────────────────────────────────────────

// !! CHANGE THIS to match your Arduino's port !!
// Windows example: 'COM3'
// Mac example:     '/dev/cu.usbmodem14101'
// Linux example:   '/dev/ttyACM0'
const SERIAL_PORT = 'COM3';

// Baud rate must match exactly what's in the Arduino sketch.
// The sketch uses Serial.begin(9600), so we use 9600 here.
const BAUD_RATE = 9600;

// The folder where your HTML/CSS/JS files live.
// __dirname is the folder this server.js file is in.
// So this means "look for page.html in the same folder as server.js".
const STATIC_DIR = __dirname;

// The Excel file with all the trivia questions.
const QUESTIONS_FILE = path.join(__dirname, 'trivia_game.xlsx');

// HTTP port for the browser to load the page.
const HTTP_PORT = 3000;

// WebSocket port for real-time communication with the browser.
const WS_PORT = 8080;


// ── LOAD QUESTIONS FROM EXCEL ─────────────────────────────────

// We load all questions once at startup and keep them in memory.
// This way we never touch the file again during the game.

function loadQuestions() {
  // Read the Excel file from disk into memory.
  const workbook = XLSX.readFile(QUESTIONS_FILE);

  // Get the first sheet (your file only has one sheet).
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Convert the sheet into an array of plain objects.
  // Each object has keys matching the header row:
  // { 'Question ID', 'Question', 'Category',
  //   'Option A', 'Option B', 'Option C', 'Option D',
  //   'Correct Answer' }
  const rows = XLSX.utils.sheet_to_json(sheet);

  console.log(`Loaded ${rows.length} questions from ${QUESTIONS_FILE}`);
  return rows;
}

const ALL_QUESTIONS = loadQuestions();

// Keep track of which questions have already been asked this session,
// so we never repeat a question until all have been used.
const usedQuestionIndices = new Set();

function getRandomQuestion() {
  // If every question has been used, reset and start over.
  if (usedQuestionIndices.size >= ALL_QUESTIONS.length) {
    usedQuestionIndices.clear();
    console.log('All questions used — reshuffling.');
  }

  // Pick a random index that hasn't been used yet.
  let index;
  do {
    index = Math.floor(Math.random() * ALL_QUESTIONS.length);
  } while (usedQuestionIndices.has(index));

  usedQuestionIndices.add(index);
  return ALL_QUESTIONS[index];
}


// ── GAME STATE ────────────────────────────────────────────────

// The game is always in exactly one of these states.
// Every piece of logic checks this before doing anything.
//
//   IDLE       — Waiting for admin to start a round.
//                No question shown. Admin presses → QUESTION.
//
//   QUESTION   — A question is displayed on screen.
//                Admin presses again → SPINNING.
//
//   SPINNING   — The Arduino is running the spin animation.
//                Any player who presses now is DISQUALIFIED
//                for this round.
//                Arduino sends SPINDONE → BUZZABLE.
//
//   BUZZABLE   — Spin has stopped. First player to press wins
//                the buzzer. Their name shows on screen.
//                Admin then picks the answer on screen → ANSWERED.
//
//   ANSWERED   — Admin has selected an answer.
//                LEDs show win/lose. Scores updated.
//                Admin presses again → IDLE (next round).

const STATE = {
  IDLE:      'IDLE',
  QUESTION:  'QUESTION',
  SPINNING:  'SPINNING',
  BUZZABLE:  'BUZZABLE',
  ANSWERED:  'ANSWERED',
};

// The current state starts as IDLE.
let gameState = STATE.IDLE;

// The current question being shown. null when no question is active.
let currentQuestion = null;

// Which player has buzzed in this round. null = nobody yet.
// Value will be 'P1', 'P2', 'P3', or 'P4'.
let buzzer = null;

// Which players are disqualified this round (pressed during spin).
// This is a Set, so we can have multiple disqualified players.
const disqualified = new Set();

// Player scores and names.
// The browser sends names when players type them in.
// Scores start at 0 and change as the game progresses.
const players = {
  P1: { name: 'Yellow', score: 0 },
  P2: { name: 'Red',    score: 0 },
  P3: { name: 'Blue',   score: 0 },
  P4: { name: 'Green',  score: 0 },
};


// ── SERIAL PORT SETUP ─────────────────────────────────────────

// Open a connection to the Arduino over USB.
const port = new SerialPort({
  path: SERIAL_PORT,
  baudRate: BAUD_RATE,
  // autoOpen: false would let us open manually. true (default) opens immediately.
});

// The parser splits incoming bytes into complete lines.
// Every time the Arduino sends a \n, we get one complete message.
const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

// Called when the serial port successfully opens.
port.on('open', () => {
  console.log(`Serial port ${SERIAL_PORT} opened at ${BAUD_RATE} baud.`);
});

// Called if the serial port fails to open (wrong port, Arduino not connected, etc.)
port.on('error', (err) => {
  console.error('Serial port error:', err.message);
  console.error('Check that SERIAL_PORT in server.js matches your Arduino\'s port.');
});

process.on('uncaughtException', (err) => {
    if (err.message.includes('ENOENT') || err.message.includes('cannot open')) {
        console.error('Arduino not found on', SERIAL_PORT, '— continuing without it.');
    } else {
        throw err;
    }
});

// Called every time the Arduino sends a complete line.
// This is the main entry point for all Arduino → server communication.
parser.on('data', (line) => {
  const msg = line.trim();
  if (!msg) return; // ignore empty lines

  console.log(`Arduino → Server: "${msg}"`);

  if (msg === 'ADMIN') {
    handleAdminPress();
  } else if (msg === 'SPINDONE') {
    handleSpinDone();
  } else if (['P1', 'P2', 'P3', 'P4'].includes(msg)) {
    handlePlayerPress(msg);
  }
});

// Helper: send a command string to the Arduino over serial.
// We add \n at the end because the Arduino uses readStringUntil('\n').
function sendToArduino(command) {
  console.log(`Server → Arduino: "${command}"`);
  port.write(command + '\n', (err) => {
    if (err) console.error('Failed to write to serial port:', err.message);
  });
}


// ── WEBSOCKET SERVER ──────────────────────────────────────────

// Create a WebSocket server on port 8080.
// The browser's page.js will connect to ws://localhost:8080.
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('listening', () => {
  console.log(`WebSocket server running on ws://localhost:${WS_PORT}`);
});

// Called each time a browser connects.
wss.on('connection', (ws) => {
  console.log('Browser connected via WebSocket.');

  // Send the current game state immediately so the page syncs up
  // even if someone refreshes mid-game.
  sendState(ws);

  // Listen for messages coming FROM the browser.
  // The only message type the browser sends is ANSWER (A, B, C, or D).
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      console.log('Browser → Server:', msg);

      if (msg.type === 'ANSWER') {
        handleAnswer(msg.answer);
      } else if (msg.type === 'SET_NAME') {
        // The browser sends player names when entered.
        // msg = { type: 'SET_NAME', player: 'P1', name: 'Alice' }
        if (players[msg.player] !== undefined) {
          players[msg.player].name = msg.name || players[msg.player].name;
          broadcastScores();
        }
      }
    } catch (e) {
      console.error('Bad message from browser:', data.toString());
    }
  });

  ws.on('close', () => {
    console.log('Browser disconnected.');
  });
});

// Send a JSON message to one specific WebSocket client.
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Send a JSON message to ALL connected browser clients.
// (There's usually only one browser window open, but this handles extras.)
function broadcast(obj) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(obj));
    }
  });
}

// Send the full current game state to one client.
// Used when a new browser connects so it catches up immediately.
function sendState(ws) {
  send(ws, {
    type: 'STATE',
    state: gameState,
    question: currentQuestion ? formatQuestion(currentQuestion) : null,
    buzzer: buzzer,
    players: players,
    disqualified: Array.from(disqualified),
  });
}

// Send updated scores to all browsers.
function broadcastScores() {
  broadcast({
    type: 'SCORES',
    players: players,
  });
}

// Convert a raw Excel row into the clean format the browser expects.
function formatQuestion(q) {
  return {
    category: q['Category'],
    question: q['Question'],
    optionA:  q['Option A'],
    optionB:  q['Option B'],
    optionC:  q['Option C'],
    optionD:  q['Option D'],
    // We do NOT send the correct answer to the browser.
    // The server checks it here. This prevents cheating via DevTools.
  };
}


// ── HTTP SERVER ───────────────────────────────────────────────

// Serve the static files (page.html, page.js, page.css, trivia_game.csv)
// so the browser can load the page by visiting http://localhost:3000.

const httpServer = http.createServer((req, res) => {
  // Decide which file to serve based on the URL.
  // '/' means the root, which we map to page.html.
  let filePath = req.url === '/' ? '/page.html' : req.url;

  // Build the full path on disk.
  const fullPath = path.join(STATIC_DIR, filePath);

  // Determine the Content-Type header based on file extension.
  // This tells the browser what kind of file it's receiving.
  const ext = path.extname(fullPath).toLowerCase();
  const contentTypes = {
    '.html': 'text/html',
    '.js':   'text/javascript',
    '.css':  'text/css',
    '.csv':  'text/csv',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const contentType = contentTypes[ext] || 'application/octet-stream';

  // Read the file and send it to the browser.
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      // File not found — send a 404 error.
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`File not found: ${filePath}`);
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`HTTP server running on http://localhost:${HTTP_PORT}`);
  console.log('Open that URL in your browser to start the game.');
});


// ── GAME LOGIC ────────────────────────────────────────────────

// handleAdminPress() is the core state machine driver.
// Every time the admin presses their button, this runs.
// The action taken depends entirely on the current state.

function handleAdminPress() {
  console.log(`Admin pressed. Current state: ${gameState}`);

  if (gameState === STATE.IDLE) {
    // Admin starts a new round.
    // Pick a question and show it on screen.
    currentQuestion = getRandomQuestion();
    buzzer = null;
    disqualified.clear();
    gameState = STATE.QUESTION;

    broadcast({
      type: 'STATE',
      state: gameState,
      question: formatQuestion(currentQuestion),
      buzzer: null,
      players: players,
      disqualified: [],
    });

    console.log(`New question: ${currentQuestion['Question']}`);

  } else if (gameState === STATE.QUESTION) {
    // Admin starts the spin.
    // Tell the Arduino to run the spin animation.
    gameState = STATE.SPINNING;

    broadcast({
      type: 'STATE',
      state: gameState,
      question: formatQuestion(currentQuestion),
      buzzer: null,
      players: players,
      disqualified: Array.from(disqualified),
    });

    sendToArduino('LED:SPIN');
    console.log('Spin started.');

  } else if (gameState === STATE.ANSWERED) {
    // Admin acknowledges result and starts next round.
    gameState = STATE.IDLE;
    currentQuestion = null;
    buzzer = null;
    disqualified.clear();

    sendToArduino('LED:OFF');

    broadcast({
      type: 'STATE',
      state: gameState,
      question: null,
      buzzer: null,
      players: players,
      disqualified: [],
    });

    console.log('Round over. Back to IDLE.');
  }
  // If the state is SPINNING or BUZZABLE, admin presses do nothing.
  // (The spin must complete on its own, and a player must buzz in.)
}


// handleSpinDone() is called when the Arduino sends "SPINDONE".
// This means the spin animation has finished and players can now buzz.

function handleSpinDone() {
  if (gameState !== STATE.SPINNING) return; // ignore if unexpected

  gameState = STATE.BUZZABLE;

  broadcast({
    type: 'STATE',
    state: gameState,
    question: formatQuestion(currentQuestion),
    buzzer: null,
    players: players,
    disqualified: Array.from(disqualified),
  });

  console.log('Spin done. Players can now buzz in.');
}


// handlePlayerPress(player) is called when a player button is pressed.
// 'player' is 'P1', 'P2', 'P3', or 'P4'.

function handlePlayerPress(player) {
  if (gameState === STATE.SPINNING) {
    // Player pressed TOO EARLY during the spin.
    // They are disqualified for this round.
    if (!disqualified.has(player)) {
      disqualified.add(player);
      console.log(`${players[player].name} (${player}) pressed early — disqualified this round.`);

      broadcast({
        type: 'DISQUALIFIED',
        player: player,
        name: players[player].name,
        disqualified: Array.from(disqualified),
      });
    }

  } else if (gameState === STATE.BUZZABLE) {
    // Player pressed during the valid buzzer window.
    // Only the FIRST player to press gets the buzzer.
    // Disqualified players cannot buzz in.

    if (buzzer !== null) return;             // someone already buzzed
    if (disqualified.has(player)) return;    // this player is disqualified

    buzzer = player;
    gameState = STATE.BUZZABLE; // stays BUZZABLE until admin picks answer

    console.log(`${players[player].name} (${player}) buzzed in!`);

    broadcast({
      type: 'BUZZED',
      player: player,
      name: players[player].name,
    });
  }
}


// handleAnswer(answer) is called when the admin clicks an answer button
// on the screen (A, B, C, or D).
// 'answer' is the letter string: 'A', 'B', 'C', or 'D'.

function handleAnswer(answer) {
  // Only process answers when someone has buzzed in.
  if (gameState !== STATE.BUZZABLE || buzzer === null) {
    console.log('Answer received but no active buzzer — ignoring.');
    return;
  }

  const correct = currentQuestion['Correct Answer']; // e.g. 'A'
  const isCorrect = (answer === correct);
  const playerName = players[buzzer].name;

  if (isCorrect) {
    // Correct answer: +1 point, corner LEDs light up.
    players[buzzer].score += 1;
    sendToArduino('LED:WIN');
    console.log(`${playerName} answered correctly! Score: ${players[buzzer].score}`);
  } else {
    // Wrong answer: -1 point, all LEDs light up.
    players[buzzer].score -= 1;
    sendToArduino('LED:LOSE');
    console.log(`${playerName} answered incorrectly. Score: ${players[buzzer].score}`);
  }

  gameState = STATE.ANSWERED;

  broadcast({
    type: 'RESULT',
    correct: isCorrect,
    selectedAnswer: answer,
    correctAnswer: correct,
    player: buzzer,
    name: playerName,
    players: players,
  });

  console.log(`Correct answer was: ${correct}. Admin presses to continue.`);
}
