// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const Redis = require('./redis');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('public'));

const ROOM = 'snake:room1';        // 所有玩家共用同一个房间
const TICK_RATE = 100;             // 10 FPS (100ms 一帧)
const GRID_SIZE = 30;              // 30x30 格子
const INITIAL_LENGTH = 3;
const READY_SET = 'snake:ready_players';   // 新增：用 Set 保存已准备的玩家ID

// 游戏状态（只保存在 Redis，方便以后多实例）
async function getGameState() {
  const data = await Redis.get(ROOM);
  return data ? JSON.parse(data) : {
    food: generateFood(),
    players: {}   // id -> {x,y,dir,body[],color,score,name,dead}
  };
}

// 在 getGameState 旁边加一个获取准备列表的函数
async function getReadyPlayers() {
  const members = await Redis.smembers(READY_SET);
  return new Set(members);
}

function generateFood(exclude = []) {
  while (true) {
    const x = Math.floor(Math.random() * GRID_SIZE);
    const y = Math.floor(Math.random() * GRID_SIZE);
    if (!exclude.some(p => p.x === x && p.y === y)) {
      return { x, y };
    }
  }
}

// 广播整个游戏状态给所有在线玩家
async function broadcastState() {
  const state = await getGameState();
  const msg = JSON.stringify({ type: 'state', state });
  Redis.publish(ROOM, msg);
}

// 每帧逻辑
async function gameLoop() {
  const state = await getGameState();
  const readyIds = await getReadyPlayers();

  // 移动每条蛇
  for (const id in state.players) {
    const p = state.players[id];
    if (!readyIds.has(id)) {
      // 未准备的玩家不参与任何逻辑（连碰撞都不算）
      continue;
    }
    if (p.dead) continue;

    const head = { x: p.x, y: p.y };

    switch (p.dir) {
      case 'UP':    head.y -= 1; break;
      case 'DOWN':  head.y += 1; break;
      case 'LEFT':  head.x -= 1; break;
      case 'RIGHT': head.x += 1; break;
    }

    // 撞墙
    if (head.x < 0 || head.x >= GRID_SIZE || head.y < 0 || head.y >= GRID_SIZE) {
      p.dead = true;
      continue;
    }

    // 撞自己或别人
    for (const pid in state.players) {
      const body = state.players[pid].body;
      if (body.some(seg => seg.x === head.x && seg.y === head.y)) {
        p.dead = true;
        break;
      }
    }
    if (p.dead) continue;

    p.body.unshift({ ...head });
    p.x = head.x;
    p.y = head.y;

    // 吃食物
    if (head.x === state.food.x && head.y === state.food.y) {
      p.score += 10;
      state.food = generateFood(state.players[id].body.concat(Object.values(state.players).flatMap(p => p.body)));
    } else {
      p.body.pop(); // 没吃到就去掉尾巴
    }
  }

  await Redis.set(ROOM, JSON.stringify(state));
  broadcastState();
}

setInterval(gameLoop, TICK_RATE);

// WebSocket 连接处理
wss.on('connection', async (ws) => {
  const playerId = Date.now() + Math.random().toString(36).substr(2, 5);
  const colors = ['#ff5722','#4caf50','#2196f3','#e91e63','#ffc107','#9c27b0'];
  const color = colors[Math.floor(Math.random() * colors.length)];

  // 创建新玩家
  const newPlayer = {
    x: Math.floor(GRID_SIZE / 2),
    y: Math.floor(GRID_SIZE / 2),
    dir: 'RIGHT',
    body: [],
    color,
    score: 0,
    name: `Player${playerId.slice(-4)}`,
    dead: false
  };
  // 初始化身体
  for (let i = INITIAL_LENGTH - 1; i >= 0; i--) {
    newPlayer.body.push({ x: newPlayer.x - i, y: newPlayer.y });
  }

  const state = await getGameState();
  state.players[playerId] = newPlayer;
  await Redis.set(ROOM, JSON.stringify(state));
  broadcastState();

  ws.send(JSON.stringify({ type: 'init', id: playerId, color }));

  // 监听 Redis 广播，转发给这个 ws
  const sub = Redis.duplicate();
  sub.subscribe(ROOM);
  sub.on('message', (channel, message) => {
    if (channel === ROOM) ws.send(message);
  });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'direction' && ['UP','DOWN','LEFT','RIGHT'].includes(msg.dir)) {
        const state = await getGameState();
        const p = state.players[playerId];
        if (p && !p.dead) {
          // 防止 180 度掉头
          if (
            (p.dir === 'UP' && msg.dir === 'DOWN') ||
            (p.dir === 'DOWN' && msg.dir === 'UP') ||
            (p.dir === 'LEFT' && msg.dir === 'RIGHT') ||
            (p.dir === 'RIGHT' && msg.dir === 'LEFT')
          ) return;

          p.dir = msg.dir;
          await Redis.set(ROOM, JSON.stringify(state));
        }
      }
    } catch (e) { }
  });

  ws.on('close', async () => {
    const state = await getGameState();
    delete state.players[playerId];
    await Redis.set(ROOM, JSON.stringify(state));
    sub.quit();
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});