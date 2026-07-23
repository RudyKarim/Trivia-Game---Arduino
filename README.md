# Electronic Trivia Game

An interactive electronic trivia game that combines an Arduino-based buzzer system with a web interface. The game supports 4 players, live scoring, random questions, LED feedback, and real-time browser updates.

## Project Overview

This project is a digital trivia game where players compete by pressing physical buzzers connected to an Arduino. A Node.js server controls the game logic, communicates with the Arduino through a serial port, and updates the browser interface using WebSockets.

## Features

- 4-player buzzer system
- Admin button to control game flow
- Random questions loaded from an Excel file
- No repeated questions until all questions are used
- Real-time scoreboard
- Player name customization
- Early buzz disqualification
- Correct/wrong answer detection
- LED feedback for spin, win, lose, and reset states
- Web interface for displaying questions and answers

## Tech Stack

- Node.js
- JavaScript
- HTML
- CSS
- WebSocket
- SerialPort
- Arduino
- Excel / XLSX question database

## Project Structure

```
projet_num/
│
├── server.js              # Main backend server and game logic
├── page.html              # Web interface
├── page.css               # Interface styling
├── page.js                # Browser-side WebSocket logic
├── trivia_game.xlsx       # Trivia questions database
├── trivia_game.csv        # Question data file
├── package.json           # Project dependencies and scripts
├── package-lock.json
└── tsconfig.json
```
## Installation

Make sure Node.js is installed.

Clone the repository:
```python
git clone https://github.com/KhaledMourabet/projet_num.git
cd projet_num
```

## Acknowledgments

This project was made possible through the hard work, dedication, and teamwork of:

- **Khaled Mourabet**
- **Hadi Bou Chebel**
- **Rudy Karim**

We are proud of what we accomplished together.
