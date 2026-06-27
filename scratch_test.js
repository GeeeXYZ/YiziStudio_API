const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const secret = process.env.JWT_SECRET || 'c2a5598687a748c9df4091a7e2b10952d75fbf80a6b9a89cde99a4fb792a63ff';

const unionid = 'usr_02d9a9ce61a6afc5'; // I need a valid user ID or unionid from the database
const phone = '13600408635';

const token = jwt.sign({ unionid, phone }, secret, { expiresIn: '30d' });

async function test() {
  // 1. Check points
  let res = await fetch('http://localhost:3000/client/user/points', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  console.log('Points before:', await res.json());

  // 2. Submit comment (Remake)
  // Need a valid order ID and indices.
  // We can query the database to find one.
}
test();
