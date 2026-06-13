const http = require('http');

const req = http.request('http://13.207.92.133:8080/health', {
  method: 'OPTIONS',
  headers: {
    'Origin': 'http://localhost:55327'
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Headers:', res.headers);
    console.log('Body:', data);
  });
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
});

req.end();
