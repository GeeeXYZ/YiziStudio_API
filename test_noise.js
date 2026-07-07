import sharp from 'sharp';

async function test() {
  const metadata = { width: 500, height: 500 };
  const noiseOpacity = 0.5;
  const svgNoise = Buffer.from(`
    <svg width="${metadata.width}" height="${metadata.height}" xmlns="http://www.w3.org/2000/svg">
      <filter id="noise">
        <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" result="noise" />
        <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${noiseOpacity} 0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#noise)" fill="white" />
    </svg>
  `);
  
  await sharp({
    create: {
      width: 500,
      height: 500,
      channels: 4,
      background: { r: 100, g: 100, b: 100, alpha: 1 }
    }
  })
  .composite([{ input: svgNoise, blend: 'overlay' }])
  .png()
  .toFile('test_noise.png');
  console.log('done');
}
test();
