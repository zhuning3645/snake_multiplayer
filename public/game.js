//客户端
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const GRID = 20;
const SIZE = canvas.width / GRID;

let myId = null;
let myColor = null;

const ws = new WebSocket(`ws://${location.host}`);

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'init') {
    myId = msg.id;
    myColor = msg.color;
  }
  if (msg.type === 'state') {
    draw(msg.state);
  }
};

function draw(state) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 画食物
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(state.food.x * SIZE + 2, state.food.y * SIZE + 2, SIZE - 4, SIZE - 4);

  // 画所有蛇
  for (const id in state.players) {
    const p = state.players[id];
    p.body.forEach((seg, i) => {
      ctx.fillStyle = i === 0 ? '#fff' : p.color;
      if (p.dead) ctx.globalAlpha = 0.4;
      ctx.fillRect(seg.x * SIZE + 2, seg.y * SIZE + 2, SIZE - 4, SIZE - 4);
      ctx.globalAlpha = 1;
    });

    // 名字和分数
    if (p.body.length > 0) {
      ctx.fillStyle = '#fff';
      ctx.font = '12px Arial';
      ctx.textAlign = 'center';
      ctx.fillText(`${p.name}: ${p.score}`, p.body[0].x * SIZE + SIZE/2, p.body[0].y * SIZE - 6);
    }
  }

  // 排行榜
  const sorted = Object.values(state.players)
    .sort((a,b) => b.score - a.score)
    .map(p => `${p.name}(${p.dead?'死':'活'}) ${p.score}`)
    .join(' | ');
  document.getElementById('scoreboard').textContent = '排行: ' + sorted;
}

// 方向控制（防连点太快）
const directionQueue = [];
let lastSend = 0;
document.addEventListener('keydown', e => {
  const map = {
    ArrowUp:    'UP',
    ArrowDown:  'DOWN',
    ArrowLeft:  'LEFT',
    ArrowRight: 'RIGHT',
    w: 'UP', s: 'DOWN', a: 'LEFT', d: 'RIGHT'
  };
  const dir = map[e.key];
  if (dir && Date.now() - lastSend > 80) {  // 最多每80ms改一次方向
    directionQueue.push(dir);
    lastSend = Date.now();
  }
});

setInterval(() => {
  if (directionQueue.length && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'direction', dir: directionQueue.shift() }));
  }
}, 50);