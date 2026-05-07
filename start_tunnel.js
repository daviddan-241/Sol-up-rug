const lt = require('localtunnel');
(async () => {
  const port = 3000;
  const tunnel = await lt({ port });
  console.log('PUBLIC_URL', tunnel.url);
  tunnel.on('close', () => {
    console.log('tunnel closed');
  });
  // keep alive
  setInterval(() => {}, 1 << 30);
})();
