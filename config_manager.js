import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypt a string using AES-256-GCM.
 * Requires YIZI_MASTER_KEY in environment variables.
 * @param {string} text - The plaintext string to encrypt.
 * @returns {string} The encrypted string in format: iv:authTag:encryptedText
 */
export function encrypt(text) {
  const masterKey = process.env.YIZI_MASTER_KEY;
  if (!masterKey) throw new Error('YIZI_MASTER_KEY is not defined in .env');

  // Ensure key is 32 bytes for AES-256
  const key = crypto.createHash('sha256').update(String(masterKey)).digest('base64').substring(0, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key), iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a string using AES-256-GCM.
 * @param {string} encryptedData - The encrypted string format: iv:authTag:encryptedText
 * @returns {string} The decrypted plaintext string.
 */
export function decrypt(encryptedData) {
  const masterKey = process.env.YIZI_MASTER_KEY;
  if (!masterKey) throw new Error('YIZI_MASTER_KEY is not defined in .env');

  const key = crypto.createHash('sha256').update(String(masterKey)).digest('base64').substring(0, 32);
  const parts = encryptedData.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted data format');

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encryptedText = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key), iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Get a setting from the database, decrypting if necessary.
 * Falls back to process.env if not found in the DB.
 */
export async function getSetting(pool, key) {
  try {
    const res = await pool.query('SELECT value, is_secret FROM yizi_settings WHERE key = $1', [key]);
    if (res.rows.length > 0) {
      const row = res.rows[0];
      if (row.is_secret && row.value) {
        try {
          return decrypt(row.value);
        } catch (e) {
          console.error(`[Settings] Failed to decrypt ${key}: ${e.message}`);
          return process.env[key] || '';
        }
      }
      return row.value;
    }
  } catch (err) {
    // If table doesn't exist yet, just fallback
  }
  return process.env[key] || '';
}
