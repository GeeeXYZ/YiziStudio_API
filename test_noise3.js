import sharp from 'sharp';

async function testNodeNoise() {
  const noiseSize = 256;
  const buffer = Buffer.alloc(noiseSize * noiseSize * 3);
  const amplitude = 50; // out of 127
  
  for (let i = 0; i < buffer.length; i += 3) {
    const val = Math.floor(128 + (Math.random() * 2 - 1) * amplitude);
    buffer[i] = val;
    buffer[i+1] = val;
    buffer[i+2] = val;
  }
  
  // Test overlay on 4-channel image
  await sharp({
    create: {
      width: 500,
      height: 500,
      channels: 4,
      background: { r: 100, g: 100, b: 100, alpha: 1 }
    }
  })
  .composite([
    {
      input: buffer,
      raw: { width: noiseSize, height: noiseSize, channels: 3 },
      tile: true,
      blend: 'overlay'
    }
  ])
  .png()
  .toFile('test_noise3.png');
  
  const stats = await sharp('test_noise3.png').stats();
  console.log(stats.channels[0]);
}
testNodeNoise();
