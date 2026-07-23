'use strict';

// ============================================================
// TRIVIA GAME — browser-side JavaScript (page.js)
// ------------------------------------------------------------
// This file runs in the browser. Its only job is:
//   1. Connect to the server via WebSocket
//   2. Update the page when the server sends game events
//   3. Send the admin's answer selection back to the server
//
// It does NOT load questions, does NOT talk to the Arduino,
// and does NOT keep score — all of that is in server.js.
// ============================================================


// ── WEBSOCKET CONNECTION ──────────────────────────────────────

// Connect to the server's WebSocket on port 8080.
// This is the same port the server listens on in server.js.
const ws = new WebSocket('ws://localhost:8080');

// Called once the WebSocket connection is successfully opened.
ws.addEventListener('open', () => {
    console.log('Connected to server.');
    setStatus('Connected. Waiting for admin...', 'state-idle');
});

// Called if the connection fails or drops.
ws.addEventListener('close', () => {
    console.warn('Disconnected from server.');
    setStatus('Disconnected from server. Is server.js running?', 'state-error');
});

ws.addEventListener('error', () => {
    setStatus('Cannot connect to server. Start server.js first.', 'state-error');
});

// Called every time the server sends a message.
// This is the main entry point for all server → browser communication.
ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    console.log('Server → Browser:', msg);

    // Route the message to the right handler based on its type.
    switch (msg.type) {

        case 'STATE':
            // Server sends this on connect and on every state transition.
            // It contains everything: current state, question, scores, etc.
            handleStateMessage(msg);
            break;

        case 'BUZZED':
            // A player buzzed in. Show their name and enable answer buttons.
            handleBuzzed(msg);
            break;

        case 'DISQUALIFIED':
            // A player pressed during the spin. Mark their card.
            handleDisqualified(msg);
            break;

        case 'RESULT':
            // Admin selected an answer. Show correct/wrong and update scores.
            handleResult(msg);
            break;

        case 'SCORES':
            // Scores changed (e.g. name was updated). Refresh scoreboard.
            updateScoreboard(msg.players);
            break;
    }
});


// ── STATE HANDLER ─────────────────────────────────────────────

// handleStateMessage() is called when the server sends a full STATE snapshot.
// This happens when the browser first connects, and after every state change.

function handleStateMessage(msg) {
    // Update the scoreboard with current scores and names.
    updateScoreboard(msg.players);

    // Clear any leftover disqualification markers from last round.
    clearDisqualified();

    // Re-apply disqualifications if we're mid-round.
    if (msg.disqualified) {
        msg.disqualified.forEach(p => markDisqualified(p));
    }

    // Update the page layout based on the current game state.
    switch (msg.state) {

        case 'IDLE':
            // No question active. Reset everything.
            setStatus('Waiting for admin to start...', 'state-idle');
            setQuestion(null);
            setAnswerButtons(null, false); // disabled, no options shown
            clearBuzzer();
            hideResult();
            break;

        case 'QUESTION':
            // A question is loaded and showing. Waiting for admin to start spin.
            setStatus('Question loaded. Admin: press to start the spin.', 'state-question');
            setQuestion(msg.question);
            setAnswerButtons(msg.question, false); // visible but disabled
            clearBuzzer();
            hideResult();
            break;

        case 'SPINNING':
            // LEDs are spinning. Players must not buzz yet.
            setStatus('Spinning! Do not buzz yet...', 'state-spinning');
            setQuestion(msg.question);
            setAnswerButtons(msg.question, false); // still disabled
            clearBuzzer();
            hideResult();
            break;

        case 'BUZZABLE':
            if (msg.buzzer) {
                // Someone already buzzed in (we're catching up after a refresh).
                const name = msg.players[msg.buzzer]?.name || msg.buzzer;
                setStatus(`${name} is answering! Admin: select the answer.`, 'state-buzzed');
                setAnswerButtons(msg.question, true); // enabled for admin
                highlightBuzzer(msg.buzzer);
            } else {
                // Spin finished, waiting for first buzz.
                setStatus('Buzz in now!', 'state-buzzable');
                setAnswerButtons(msg.question, false);
                clearBuzzer();
            }
            break;

        case 'ANSWERED':
            // Answer was submitted. Waiting for admin to continue.
            setStatus('Admin: press to start the next round.', 'state-answered');
            setAnswerButtons(msg.question, false);
            break;
    }
}


// ── EVENT HANDLERS ────────────────────────────────────────────

function handleBuzzed(msg) {
    // A player successfully buzzed in.
    // Show their name in the status bar and highlight their card.
    setStatus(`${msg.name} buzzed in! Admin: select the answer.`, 'state-buzzed');
    setAnswerButtons(null, true); // enable answer buttons for admin to click
    highlightBuzzer(msg.player);
}

function handleDisqualified(msg) {
    // A player pressed too early during the spin.
    markDisqualified(msg.player);
    // Update status to mention who was disqualified.
    setStatus(
        `${msg.name} pressed too early and is disqualified this round! Spinning...`,
        'state-spinning'
    );
}

function handleResult(msg) {
    // The admin selected an answer. Update scores and show result.
    updateScoreboard(msg.players);

    const resultEl = document.getElementById('result-message');
    if (msg.correct) {
        resultEl.textContent = `Correct! ${msg.name} gets +1 point.`;
        resultEl.className = 'result-message result-correct';
        setStatus(`Correct! Admin: press to continue.`, 'state-correct');
    } else {
        resultEl.textContent =
            `Wrong! The correct answer was ${msg.correctAnswer}. ${msg.name} loses 1 point.`;
        resultEl.className = 'result-message result-wrong';
        setStatus(`Wrong answer. Admin: press to continue.`, 'state-wrong');
    }

    // Highlight the correct answer button in green,
    // and the wrong one in red if a wrong answer was selected.
    revealAnswers(msg.selectedAnswer, msg.correctAnswer);
}


// ── DOM HELPERS ───────────────────────────────────────────────

// setStatus(text, cssClass) updates the status bar at the top.
// cssClass controls the background color via CSS (see page.css).
function setStatus(text, cssClass) {
    const bar = document.getElementById('status-bar');
    bar.textContent = text;
    // Remove all state-* classes, then add the new one.
    bar.className = cssClass;
}

// setQuestion(q) updates the category and question text.
// If q is null, resets to the default placeholder text.
function setQuestion(q) {
    const catEl = document.getElementById('category');
    const qEl   = document.getElementById('question');

    if (!q) {
        catEl.textContent = 'Category: —';
        qEl.textContent   = 'Press the admin button to begin.';
        return;
    }

    catEl.textContent = `Category: ${q.category}`;
    qEl.textContent   = q.question;
}

// setAnswerButtons(q, enabled) updates the four answer buttons.
// If q is provided, it fills in the option text.
// enabled controls whether the admin can click them.
function setAnswerButtons(q, enabled) {
    const buttons = {
        A: document.getElementById('btn-a'),
        B: document.getElementById('btn-b'),
        C: document.getElementById('btn-c'),
        D: document.getElementById('btn-d'),
    };

    for (const [letter, btn] of Object.entries(buttons)) {
        // Reset any result coloring from the previous round.
        btn.classList.remove('answer-correct', 'answer-wrong');

        if (q) {
            // Fill in the option text from the question data.
            btn.textContent = `${letter}: ${q['option' + letter] || q['Option ' + letter]}`;
        } else {
            btn.textContent = letter;
        }

        // enabled=true means the admin can click to select an answer.
        // enabled=false means buttons are greyed out.
        btn.disabled = !enabled;
    }
}

// revealAnswers(selected, correct) colors the answer buttons
// after the admin submits an answer:
//   - correct answer → green
//   - the wrong answer that was selected → red (if different)
function revealAnswers(selected, correct) {
    const letterToId = { A: 'btn-a', B: 'btn-b', C: 'btn-c', D: 'btn-d' };

    document.getElementById(letterToId[correct]).classList.add('answer-correct');

    if (selected !== correct) {
        document.getElementById(letterToId[selected]).classList.add('answer-wrong');
    }
}

// highlightBuzzer(player) adds the buzzer glow to a player card.
function highlightBuzzer(player) {
    clearBuzzer(); // remove any previous highlight first
    const card = document.getElementById('card-' + player);
    if (card) card.classList.add('buzzer-active');
}

// clearBuzzer() removes the buzzer highlight from all cards.
function clearBuzzer() {
    document.querySelectorAll('.player-card').forEach(c => {
        c.classList.remove('buzzer-active');
    });
}

// markDisqualified(player) dims a player card to show disqualification.
function markDisqualified(player) {
    const card = document.getElementById('card-' + player);
    if (card) card.classList.add('disqualified');
}

// clearDisqualified() removes disqualification styling from all cards.
function clearDisqualified() {
    document.querySelectorAll('.player-card').forEach(c => {
        c.classList.remove('disqualified');
    });
}

// hideResult() hides the result message banner.
function hideResult() {
    const el = document.getElementById('result-message');
    el.textContent = '';
    el.className = 'result-message hidden';
}

// updateScoreboard(players) refreshes scores and names on all cards.
// players = { P1: { name, score }, P2: ..., P3: ..., P4: ... }
function updateScoreboard(players) {
    for (const [id, data] of Object.entries(players)) {
        const scoreEl = document.getElementById('score-' + id);
        if (scoreEl) scoreEl.textContent = data.score;

        // Only update the name input placeholder if the input is still visible
        // (i.e. the player hasn't confirmed their name yet).
        const input = document.getElementById('name-' + id);
        if (input && data.name) {
            input.placeholder = data.name;
        }
    }
}


// ── ANSWER BUTTON CLICK ───────────────────────────────────────

// handleAnswer(letter) is called when the admin clicks A, B, C, or D.
// It sends the selection to the server via WebSocket.
function handleAnswer(letter) {
    ws.send(JSON.stringify({ type: 'ANSWER', answer: letter }));
}


// ── PLAYER NAME INPUTS ────────────────────────────────────────

// When a player presses Enter in their name input,
// lock in their name and send it to the server.

document.addEventListener('DOMContentLoaded', () => {
    ['P1', 'P2', 'P3', 'P4'].forEach(id => {
        const input = document.getElementById('name-' + id);
        if (!input) return;

        input.addEventListener('keypress', (event) => {
            if (event.key !== 'Enter') return;

            const name = input.value.trim();
            if (!name) return; // don't confirm an empty name

            // Replace the input with a plain text span so it can't be edited.
            const span = document.createElement('span');
            span.textContent = name;
            span.className = 'player-name-display';
            input.parentNode.replaceChild(span, input);

            // Tell the server about the new name so it uses it in messages.
            ws.send(JSON.stringify({ type: 'SET_NAME', player: id, name: name }));
        });
    });
});
