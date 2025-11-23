// redis.js
const Redis = require('ioredis');

const redis = new Redis({
  host: '127.0.0.1',
  port: 6379
  // 如果你有密码/云redis在这里配置
});

module.exports = redis;