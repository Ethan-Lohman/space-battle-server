const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Game state
let gameState = 'lobby'; // lobby, playing, ended
let players = {};
let enemies = [];
let bullets = [];
let playerMines = {}; // Track mines per player: { playerId: [mineIds] }
let allMines = {}; // Track all mine data: { mineId: {x, z, ownerId} }
let roundWinner = null;
let lobbyTimer = null;
let roundStartTime = null;
let zoneRadius = 50;
let zoneShrinkInterval = null;

const LOBBY_DURATION = 15000; // 15 seconds
const MIN_PLAYERS = 2;
const MAX_MINES_PER_PLAYER = 5;

// Serve static files
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    // Send current game state to new player
    socket.emit('game-state', {
        state: gameState,
        players: Object.values(players),
        enemies: enemies,
        winner: roundWinner
    });
    
    socket.on('player-join', (data) => {
        players[socket.id] = {
            id: socket.id,
            x: data.x || 0,
            z: data.z || 0,
            rotation: 0,
            health: 100,
            alive: true
        };
        
        console.log('Player joined:', socket.id);
        
        // Broadcast to all players
        io.emit('player-joined', players[socket.id]);
        
        // Send all current players to new player
        socket.emit('all-players', Object.values(players));
        
        // Check if we should start lobby countdown
        if (gameState === 'lobby' && Object.keys(players).length >= MIN_PLAYERS && !lobbyTimer) {
            startLobbyCountdown();
        }
    });
    
    socket.on('player-update', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].z = data.z;
            players[socket.id].rotation = data.rotation;
            
            // Broadcast to other players
            socket.broadcast.emit('player-update', players[socket.id]);
        }
    });
    
    socket.on('place-mine', (data) => {
        if (gameState !== 'playing') return;
        
        // Initialize player's mine array if doesn't exist
        if (!playerMines[socket.id]) {
            playerMines[socket.id] = [];
        }
        
        // Create mine ID
        const mineId = Math.random().toString(36).substr(2, 9);
        
        // If player has 5 mines, remove oldest one
        if (playerMines[socket.id].length >= MAX_MINES_PER_PLAYER) {
            const oldestMineId = playerMines[socket.id].shift();
            delete allMines[oldestMineId];
            // Tell all clients to remove the old mine
            io.emit('mine-removed', { id: oldestMineId });
        }
        
        // Add new mine
        playerMines[socket.id].push(mineId);
        allMines[mineId] = {
            id: mineId,
            x: data.x,
            z: data.z,
            ownerId: socket.id
        };
        
        // Broadcast mine to all players - instant, appears immediately
        io.emit('mine-placed', allMines[mineId]);
        
        console.log(`Player ${socket.id} placed mine at (${data.x}, ${data.z}). Total mines: ${playerMines[socket.id].length}`);
    });
    
    socket.on('player-hit', (data) => {
        // Validate hit on server with cooldown to prevent spam
        if (players[data.targetId] && players[data.targetId].alive) {
            // Add cooldown check
            const now = Date.now();
            if (!players[data.targetId].lastHitTime) {
                players[data.targetId].lastHitTime = 0;
            }
            
            // Only apply damage if cooldown has passed
            const cooldown = data.shooterId === 'enemy' ? 1000 : (data.shooterId === 'zone' ? 500 : 500);
            if (now - players[data.targetId].lastHitTime < cooldown) {
                return; // Ignore hit, cooldown not passed
            }
            
            players[data.targetId].lastHitTime = now;
            players[data.targetId].health -= data.damage;
            
            if (players[data.targetId].health <= 0) {
                players[data.targetId].alive = false;
                players[data.targetId].health = 0;
                
                io.emit('player-eliminated', {
                    eliminatedId: data.targetId,
                    killerId: data.shooterId
                });
                
                checkRoundEnd();
            } else {
                io.emit('player-damaged', {
                    playerId: data.targetId,
                    health: players[data.targetId].health
                });
            }
        }
    });
    
    socket.on('enemy-hit', (data) => {
        // Find and update enemy
        const enemy = enemies.find(e => e.id === data.enemyId);
        if (enemy) {
            enemy.health -= data.damage;
            
            if (enemy.health <= 0) {
                // Remove enemy
                enemies = enemies.filter(e => e.id !== data.enemyId);
                io.emit('enemy-destroyed', { id: data.enemyId, shooterId: data.shooterId });
            } else {
                io.emit('enemy-damaged', { id: data.enemyId, health: enemy.health });
            }
        }
    });
    
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        
        if (players[socket.id]) {
            delete players[socket.id];
            io.emit('player-left', { id: socket.id });
            
            // Check if round should end
            if (gameState === 'playing') {
                checkRoundEnd();
            }
            
            // Cancel lobby if not enough players
            if (gameState === 'lobby' && Object.keys(players).length < MIN_PLAYERS && lobbyTimer) {
                clearTimeout(lobbyTimer);
                lobbyTimer = null;
                io.emit('lobby-cancelled');
            }
        }
    });
});

function startLobbyCountdown() {
    console.log('Starting lobby countdown...');
    io.emit('lobby-countdown', { duration: LOBBY_DURATION / 1000 });
    
    lobbyTimer = setTimeout(() => {
        startRound();
    }, LOBBY_DURATION);
}

function startRound() {
    console.log('Starting round...');
    gameState = 'playing';
    roundStartTime = Date.now();
    enemies = [];
    bullets = [];
    playerMines = {};
    allMines = {};
    roundWinner = null;
    zoneRadius = 50;
    
    // Reset all players
    Object.keys(players).forEach(id => {
        players[id].health = 100;
        players[id].alive = true;
        players[id].x = (Math.random() - 0.5) * 40;
        players[id].z = (Math.random() - 0.5) * 40;
    });
    
    io.emit('round-start', {
        players: Object.values(players)
    });
    
    // Start spawning enemies
    startEnemySpawning();
    
    // Start zone shrinking
    startZoneShrinking();
}

function startEnemySpawning() {
    if (gameState !== 'playing') return;
    
    // Spawn enemy
    const angle = Math.random() * Math.PI * 2;
    const distance = 45;
    
    const enemy = {
        id: Math.random().toString(36).substr(2, 9),
        x: Math.cos(angle) * distance,
        z: Math.sin(angle) * distance,
        health: 30,
        targetAngle: Math.atan2(0, 0) // Aim towards center
    };
    
    enemies.push(enemy);
    io.emit('enemy-spawned', enemy);
    
    // Schedule next spawn (gets faster over time)
    const spawnDelay = Math.max(500, 2000 - (Date.now() - roundStartTime) / 10);
    setTimeout(startEnemySpawning, spawnDelay);
}

function startZoneShrinking() {
    // Clear any existing interval
    if (zoneShrinkInterval) {
        clearInterval(zoneShrinkInterval);
    }
    
    // Shrink zone every 10 seconds
    zoneShrinkInterval = setInterval(() => {
        if (gameState !== 'playing') {
            clearInterval(zoneShrinkInterval);
            return;
        }
        
        // Shrink zone by 5 units
        zoneRadius = Math.max(5, zoneRadius - 5);
        
        io.emit('zone-update', { radius: zoneRadius });
        
        // If zone is fully closed, end the round
        if (zoneRadius <= 5) {
            clearInterval(zoneShrinkInterval);
            checkRoundEnd();
        }
    }, 10000); // Every 10 seconds
}

function checkRoundEnd() {
    const alivePlayers = Object.values(players).filter(p => p.alive);
    
    if (alivePlayers.length <= 1) {
        endRound(alivePlayers[0] || null);
    }
}

function endRound(winner) {
    console.log('Round ended. Winner:', winner ? winner.id : 'None');
    gameState = 'ended';
    roundWinner = winner;
    
    // Clear zone shrinking
    if (zoneShrinkInterval) {
        clearInterval(zoneShrinkInterval);
    }
    
    io.emit('round-end', {
        winner: winner,
        players: Object.values(players).map(p => ({
            id: p.id,
            alive: p.alive
        }))
    });
    
    // Start new lobby after 10 seconds
    setTimeout(() => {
        gameState = 'lobby';
        lobbyTimer = null;
        zoneRadius = 50;
        io.emit('back-to-lobby');
        
        // Auto-start if enough players
        if (Object.keys(players).length >= MIN_PLAYERS) {
            startLobbyCountdown();
        }
    }, 10000);
}

// Update game state - Reduced frequency to decrease lag
setInterval(() => {
    if (gameState === 'playing') {
        // Update enemies
        enemies.forEach(enemy => {
            const targetAngle = Math.atan2(-enemy.z, -enemy.x);
            enemy.x += Math.cos(targetAngle) * 0.1;
            enemy.z += Math.sin(targetAngle) * 0.1;
        });
        
        // Remove enemies that reach the center (within 2 units)
        enemies = enemies.filter(enemy => {
            const distFromCenter = Math.sqrt(enemy.x * enemy.x + enemy.z * enemy.z);
            if (distFromCenter < 2) {
                io.emit('enemy-destroyed', { id: enemy.id });
                return false; // Remove this enemy
            }
            return true; // Keep this enemy
        });
        
        // Broadcast enemy updates
        io.emit('game-update', {
            enemies: enemies
        });
    }
}, 100); // 100ms update rate

http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});