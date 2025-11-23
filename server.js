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

  // 新玩家默认「未准备」状态，只存基本信息
  const state = await getGameState();
  state.players[playerId] = {
    color,
    name: `Player${playerId.slice(-4)}`,
    score: 0,
    ready: false,
    body: [],
    dead: true
  };
  await Redis.set(ROOM, JSON.stringify(state));

  // 告诉客户端自己的 id 和颜色 + 当前完整状态
  ws.send(JSON.stringify({
    type: 'welcome',
    id: playerId,
    color,
    state
  }));

  // 订阅广播
  const sub = Redis.duplicate();
  sub.subscribe(ROOM);
  sub.on('message', (_, message) => ws.send(message));


  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      // 1. 准备/取消准备
      if (msg.type === 'ready') {
        if (msg.ready) {
          await Redis.sadd(READY_SET, playerId);
          await spawnPlayer(playerId);        // 真正出生
        } else {
          await Redis.srem(READY_SET, playerId);
          await respawnToLobby(playerId);     // 回到大厅
        }
        broadcastState();
      }

      // 2. 方向控制（只有已准备的才能发）
      if (msg.type === 'direction' && ['UP','DOWN','LEFT','RIGHT'].includes(msg.dir)) {
        const readyIds = await getReadyPlayers();
        if (!readyIds.has(playerId)) return;

        const state = await getGameState();
        const p = state.players[playerId];
        if (p && !p.dead) {
          // 防止180度掉头（同之前）
          const opposite = {UP:'DOWN', DOWN:'UP', LEFT:'RIGHT', RIGHT:'LEFT'};
          if (p.dir === opposite[msg.dir]) return;
          p.dir = msg.dir;
          await Redis.set(ROOM, JSON.stringify(state));
        }
      }
    } catch (e) { console.error(e); }
  });

  ws.on('close', async () => {
    const state = await getGameState();
    delete state.players[playerId];
    await Redis.srem(READY_SET, playerId);
    await Redis.set(ROOM, JSON.stringify(state));
    sub.quit();
    broadcastState();
  });
});

// 安全随机出生点
async function spawnPlayer(id) {
  const state = await getGameState();
  const p = state.players[id];
  if (!p) return;

  // 找一个空位，最多尝试 100 次
  for (let i = 0; i < 100; i++) {
    const x = Math.floor(Math.random() * GRID_SIZE);
    const y = Math.floor(Math.random() * GRID_SIZE);
    const occupied = Object.values(state.players).some(player => 
      player.body && player.body.some(seg => seg.x === x && seg.y === y)
    );
    if (!occupied) {
      p.x = x; p.y = y;
      p.dir = 'RIGHT';
      p.body = [];
      p.dead = false;
      p.ready = true;
      for (let i = INITIAL_LENGTH - 1; i >= 0; i--) {
        p.body.push({ x: x - i, y });
      }
      await Redis.set(ROOM, JSON.stringify(state));
      return;
    }
  }
}

// 死亡或取消准备 → 回到大厅（清空身体）
async function respawnToLobby(id) {
  const state = await getGameState();
  const p = state.players[id];
  if (p) {
    p.body = [];
    p.dead = true;
    p.ready = false;
    await Redis.set(ROOM, JSON.stringify(state));
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});