
import { pool } from '../config/db.js';
import { getSetting } from '../config_manager.js';

/**
 * Send a Feishu Markdown Card notification
 * @param {string} title - Card title
 * @param {string} color - Header color (blue, green, red, yellow, etc.)
 * @param {string} markdownText - The markdown content
 */
async function sendFeishuCard(title, color, markdownText) {
  console.log(`[Notification] sendFeishuCard called with title: ${title}`);
  try {
    const webhookUrl = await getSetting(pool, 'FEISHU_WEBHOOK_URL');
    console.log(`[Notification] Fetched FEISHU_WEBHOOK_URL: ${webhookUrl}`);
    if (!webhookUrl || !webhookUrl.startsWith('http')) {
      console.log(`[Notification] Invalid or empty webhook URL, aborting.`);
      return; // Not configured or invalid, silent ignore
    }

    const isDingTalk = webhookUrl.includes('dingtalk.com');
    let payload;

    if (isDingTalk) {
      payload = {
        msgtype: 'markdown',
        markdown: {
          title: title,
          text: `### ${title}\n\n${markdownText}`
        }
      };
    } else {
      payload = {
        msg_type: 'interactive',
        card: {
          config: { wide_screen_mode: true },
          header: {
            title: { tag: 'plain_text', content: title },
            template: color
          },
          elements: [
            {
              tag: 'markdown',
              content: markdownText
            }
          ]
        }
      };
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 5000 // Do not block
    });

    if (!res.ok) {
      console.error(`[Notification] Webhook failed: ${res.statusText}`);
    }
  } catch (err) {
    console.error(`[Notification] Feishu Webhook error: ${err.message}`);
  }
}

/**
 * Handle notification events
 */
export async function handleNotification(event, payload) {
  const { orderId, openid, phone, comment, details } = payload || {};
  let title = '';
  let color = 'blue';
  let markdown = '';

  const timeStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  switch (event) {
    case 'NOTIFY_NEW_ORDER':
      title = '🛒 新订单创建';
      color = 'blue';
      markdown = `**订单 ID:** ${orderId}\n**用户:** ${phone || openid}\n**时间:** ${timeStr}\n\n*请及时在后台确认并处理。*`;
      break;

    case 'NOTIFY_NEW_COMMENT':
      title = '💬 新增反馈评论';
      color = 'yellow';
      markdown = `**订单 ID:** ${orderId}\n**用户:** ${phone || openid}\n**时间:** ${timeStr}\n\n**评论内容:**\n> ${comment || '无内容'}`;
      break;

    case 'NOTIFY_DELIVERY_COMPLETE':
      title = '📦 订单交付完成';
      color = 'green';
      markdown = `**订单 ID:** ${orderId}\n**时间:** ${timeStr}\n\n*该订单的所有套图均已交付给客户。*`;
      break;

    case 'NOTIFY_ORDER_CONFIRMED':
      title = '✅ 用户已确认签收';
      color = 'turquoise';
      markdown = `**订单 ID:** ${orderId}\n**用户:** ${phone || openid}\n**时间:** ${timeStr}\n\n*客户已满意并确认签收了该订单的交付物。*`;
      break;

    default:
      return;
  }

  // Fire and forget
  sendFeishuCard(title, color, markdown);
}
