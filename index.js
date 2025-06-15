const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();
app.use(express.json());

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.json({});
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const msg = event.message.text.toLowerCase();
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  console.log("使用者輸入：", msg);

  // FAQ 回覆
  if (msg.includes('faq') || msg.includes('常見問題')) {
    const faqCard = {
      type: 'flex',
      altText: '常見問題卡片',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '常見問題：營業時間', weight: 'bold', size: 'md' },
            { type: 'text', text: '我們每日 10:00–20:00 營業', size: 'sm', margin: 'md' }
          ]
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              style: 'link',
              action: {
                type: 'uri',
                label: '查看更多 FAQ',
                uri: 'https://your-website.com/faq'
              }
            }
          ]
        }
      }
    };
    return client.replyMessage(replyToken, faqCard);
  }

  // 預約卡片
  if (msg.includes('預約')) {
    const appointmentCard = {
      type: 'flex',
      altText: '預約卡片',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: '預約服務', weight: 'bold', size: 'md' },
            { type: 'text', text: '日期：2025/06/20', size: 'sm' },
            { type: 'text', text: '時段：上午', size: 'sm' }
          ]
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: '#00B900',
              action: {
                type: 'message',
                label: '立即預約',
                text: '我要預約 2025/06/20 上午'
              }
            }
          ]
        }
      }
    };
    return client.replyMessage(replyToken, appointmentCard);
  }

  // 「我要預約」→ 寫入 Google Sheet
  if (msg.includes('我要預約')) {
    await axios.post(
      'https://script.google.com/macros/s/AKfycbxT8-6e8d-ja8b6p5t6z9RdVeHeLgi9vHk-3Ch84_y1GvLMR4YlQxFYkOpkFVOdNt89YA/exec',
      {
        userId: userId,
        message: event.message.text
      }
    );
    return client.replyMessage(replyToken, {
      type: 'text',
      text: '已收到您的預約，我們將盡快與您聯繫！'
    });
  }

  // 預設回覆
  return client.replyMessage(replyToken, {
    type: 'text',
    text: `你說的是：「${event.message.text}」`,
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE bot 伺服器運行中，port: ${port}`);
});


