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
let mines = [];
let roundWinner = null;
let lobbyTimer = null;
let roundStartTime = null;
let zoneRadius = 50;
let zoneShrinkInterval = null;

const LOBBY_DURATION = 15000; // 15 seconds
const MIN_PLAYERS = 2;

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
    
    socket.on('player-shoot', (data) => {
        if (gameState !== 'playing') return;
        
        const bullet = {
            id: Math.random().toString(36).substr(2, 9),
            ownerId: socket.id,
            x: data.x,
            z: data.z,
            vx: data.vx,
            vz: data.vz,
            life: 100
        };
        
        bullets.push(bullet);
        
        // Broadcast to all players
        io.emit('bullet-created', bullet);
    });
    
    socket.on('player-mine', (data) => {
        if (gameState !== 'playing') return;
        
        const mine = {
            id: Math.random().toString(36).substr(2, 9),
            ownerId: socket.id,
            x: data.x,
            z: data.z
        };
        
        mines.push(mine);
        
        // Broadcast to all players
        io.emit('mine-placed', mine);
    });
    
    socket.on('mine-trigger', (data) => {
        const mine = mines.find(m => m.id === data.mineId);
        if (!mine) return;
        
        // Apply damage to all players within range
        Object.keys(players).forEach(pid => {
            if (players[pid].alive) {
                const dx = players[pid].x - mine.x;
                const dz = players[pid].z - mine.z;
                const dist = Math.sqrt(dx * dx + dz * dz);
                
                if (dist < 3) { // Explosion radius
                    const damage = 40; // Mine damage
                    players[pid].health -= damage;
                    
                    if (players[pid].health <= 0) {
                        players[pid].alive = false;
                        players[pid].health = 0;
                        
                        io.emit('player-eliminated', {
                            eliminatedId: pid,
                            killerId: mine.ownerId
                        });
                        
                        checkRoundEnd();
                    } else {
                        io.emit('player-damaged', {
                            playerId: pid,
                            health: players[pid].health
                        });
                    }
                }
            }
        });
        
        // Remove mine
        mines = mines.filter(m => m.id !== data.mineId);
        io.emit('mine-exploded', { id: data.mineId });
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
    mines = [];
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
        
        // Update bullets
        bullets = bullets.filter(bullet => {
            bullet.x += bullet.vx;
            bullet.z += bullet.vz;
            bullet.life--;
            return bullet.life > 0 && Math.abs(bullet.x) < 50 && Math.abs(bullet.z) < 50;
        });
        
        // Broadcast updates less frequently
        io.emit('game-update', {
            enemies: enemies,
            bullets: bullets
        });
    }
}, 100); // Increased from 50ms to 100ms

http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});