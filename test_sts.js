import { getOSSToken } from './utils/oss.js';

async function testSTS() {
  try {
    const token = await getOSSToken('cheapsun@gmail.com', 'ord_3803a67cdcb21d58');
    console.log("STS Token generated successfully!");
    console.log("AccessKeyId:", token.accessKeyId);
    // decode token if possible? It's just an opaque string, but we can see it succeeded.
  } catch(e) {
    console.error("STS Error:", e);
  }
}
testSTS();
