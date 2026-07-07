import sharp from 'sharp';

async function testNodeNoise() {
  const noiseSize = 256;
  const buffer = Buffer.alloc(noiseSize * noiseSize * 3);
  for (let i = 0; i < buffer.length; i += 3) {
    // Generate monochromatic noise: 0 to 255
    // But center around 128
    const val = Math.floor(Math.random() * 256);
    buffer[i] = val;
    buffer[i+1] = val;
    buffer[i+2] = val;
  }
  
  // Create a 500x500 image and tile the noise over it
  await sharp({
    create: {
      width: 500,
      height: 500,
      channels: 3,
      background: { r: 100, g: 100, b: 100 }
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
  .toFile('test_noise2.png');
  
  const stats = await sharp('test_noise2.png').stats();
  console.log(stats.channels[0]);
}
testNodeNoise();
