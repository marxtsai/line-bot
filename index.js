const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

// LINE Bot 設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

// 初始化 LINE Client
const client = new line.Client(config);
const app = express();

// ✅ 臨時用於除錯：打印實際讀取到的環境變數的值
// !!! 警告：這會讓你的 CHANNEL_SECRET 和 CHANNEL_ACCESS_TOKEN 顯示在 Render 的公開日誌中。
// !!! 除錯完成後，務必將這些 console.log 語句刪除，並重新部署！
console.log("DEBUG_ENV: Loaded CHANNEL_ACCESS_TOKEN (first 10 chars):", config.channelAccessToken ? config.channelAccessToken.substring(0, 10) + '...' : 'NOT_SET');
console.log("DEBUG_ENV: Loaded CHANNEL_SECRET (full value):", config.channelSecret || 'NOT_SET');


// LINE 的 Webhook 請求體是 JSON 格式，Express 需要這個中間件來解析
// 注意：如果請求的 Content-Type 不正確，express.json() 可能會報錯。
app.use(express.json({
  verify: (req, res, buf) => {
    // 這個 verify 函數可以確保原始請求體被保留下來，供 line.middleware 使用
    req.rawBody = buf;
  }
}));

// Webhook 路由
app.post('/webhook', (req, res) => { // 移除 line.middleware 放在 try/catch 內部
  try {
    // 手動調用 line.middleware 進行簽名驗證
    // 這樣我們可以更精確地捕獲和日誌化 SignatureValidationFailed 錯誤
    line.middleware(config)(req, res, async () => {
      // 如果簽名驗證成功，這裡的代碼才會執行
      try {
        await Promise.all(req.body.events.map(handleEvent));
        // 成功處理所有事件後，返回 200 OK 給 LINE 平台
        res.json({}); 
      } catch (err) {
        // 捕獲 handleEvent 內部或其他非簽名驗證錯誤，記錄下來
        console.error('Webhook (handleEvent) error:', err);
        // 即使發生錯誤，也要返回 200 OK 給 LINE 平台
        res.status(200).json({ status: 'error', message: err.message || 'Unknown processing error occurred' });
      }
    });
  } catch (err) {
    // 捕獲 line.middleware (主要是 SignatureValidationFailed) 拋出的錯誤
    if (err instanceof line.SignatureValidationFailed) {
      console.error('Webhook (SignatureValidationFailed) error:', err.message);
      // 對於簽名驗證失敗，也返回 200 OK，但可以不回覆訊息
      res.status(200).json({ status: 'error', message: 'Signature validation failed' });
    } else {
      // 捕獲其他未預期的頂層錯誤
      console.error('Webhook (unexpected top-level) error:', err);
      res.status(200).json({ status: 'error', message: err.message || 'Unexpected top-level error occurred' });
    }
  }
});


// 事件處理函數
async function handleEvent(event) {
  // 只處理文字訊息
  if (event.type !== 'message' || event.message.type !== 'text') {
    console.log("非文字訊息或非訊息事件，忽略。");
    return;
  }

  const msg = event.message.text.toLowerCase();
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  console.log("使用者輸入：", msg); // 在 Render Log 中顯示使用者輸入

  // Google Apps Script Web App 的 URL
  // ✅ 請確認這是你的最新部署 URL (版本 9)
  const appsScriptUrl = 'https://script.google.com/macros/s/AKfycbxT8-6e8d-ja8b6p5t6z9RdVeHeLgi9vHk-3Ch84_y1GvLMR4YlQxFYkOpkFVOdNt89YA/exec';

  // --- FAQ 回覆 ---
  if (msg.includes('faq') || msg.includes('常見問題')) {
    try {
      console.log('Sending FAQ request to Apps Script...');
      const response = await axios.post(appsScriptUrl, {
        type: 'faq',
        payload: { message: event.message.text },
        userId: userId
      });

      const data = response.data;
      if (data && data.reply) {
        if (data.timestamp) {
            console.log(`FAQ Response Timestamp for update_task_status: ${data.timestamp}`);
        }
        return client.replyMessage(replyToken, {
          type: 'text',
          text: data.reply
        });
      } else {
        console.warn('Apps Script returned no valid reply for FAQ.');
        return client.replyMessage(replyToken, {
          type: 'text',
          text: '很抱歉，獲取常見問題時發生錯誤或無相關資訊。'
        });
      }
    } catch (error) {
      console.error('Error calling Apps Script for FAQ:', error.message || error);
      // 捕獲 Apps Script 調用錯誤，並回覆使用者
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '抱歉，處理常見問題時發生系統錯誤。'
      });
    }
  }

  // --- 預約相關邏輯 ---
  if (msg.includes('預約')) {
    if (msg.includes('我要預約')) {
      try {
        console.log('Sending appointment request to Apps Script...');
        const response = await axios.post(appsScriptUrl, {
          type: 'appointment',
          payload: { message: event.message.text },
          userId: userId
        });

        const data = response.data;
        if (data && data.message) {
            return client.replyMessage(replyToken, {
                type: 'text',
                text: data.message
            });
        } else {
            console.warn('Apps Script returned no valid message for appointment.');
            return client.replyMessage(replyToken, {
                type: 'text',
                text: '預約請求處理失敗，請稍後再試。'
            });
        }
      } catch (error) {
        console.error('Error calling Apps Script for appointment:', error.message || error);
        return client.replyMessage(replyToken, {
          type: 'text',
          text: '抱歉，處理預約時發生系統錯誤。'
        });
      }

    } else {
      // 回覆預約 Flex Message 卡片
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
  }
  
  // --- 預設回覆 ---
  return client.replyMessage(replyToken, {
    type: 'text',
    text: `你說的是：「${event.message.text}」`
  });
}

// 監聽 PORT
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE bot 伺服器運行中，port: ${port}`);
});
