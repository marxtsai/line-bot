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

// LINE 的 Webhook 請求體是 JSON 格式，Express 需要這個中間件來解析
app.use(express.json());

// Webhook 路由
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    // 使用 Promise.all 並行處理所有事件
    await Promise.all(req.body.events.map(handleEvent));
    // 成功處理所有事件後，返回 200 OK 給 LINE 平台
    res.json({}); 
  } catch (err) {
    // 捕獲任何錯誤，記錄下來
    console.error('Webhook error:', err);
    // 即使發生錯誤，也要返回 200 OK 給 LINE 平台，
    // 這樣 LINE 平台就不會認為你的 Webhook 有問題而停止發送事件
    res.status(200).json({ status: 'error', message: err.message || 'Unknown error occurred' });
  }
});

// 事件處理函數
async function handleEvent(event) {
  // 只處理文字訊息
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const msg = event.message.text.toLowerCase();
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  console.log("使用者輸入：", msg); // 在 Render Log 中顯示使用者輸入

  // ✅ 修正後的 Google Apps Script Web App 的 URL
  // 現在確認這是你的最新部署 URL (版本 9)
  const appsScriptUrl = 'https://script.google.com/macros/s/AKfycbxT8-6e8d-ja8b6p5t6z9RdVeHeLgi9vHk-3Ch84_y1GvLMR4YQxFYkOpkFVOdNt89YA/exec';

  // --- FAQ 回覆 ---
  if (msg.includes('faq') || msg.includes('常見問題')) {
    // 調用 Apps Script Web App 獲取 FAQ 回覆
    try {
      const response = await axios.post(appsScriptUrl, {
        type: 'faq',
        payload: { message: event.message.text }, // 傳送原始訊息
        userId: userId
      });

      const data = response.data; // Apps Script 的回應數據

      // 檢查 Apps Script 是否成功回傳回覆
      if (data && data.reply) {
        // 如果 Apps Script 有回傳時間戳記 (Strategy One)，則在 console.log 中顯示
        if (data.timestamp) {
            console.log(`FAQ Response Timestamp for update_task_status: ${data.timestamp}`);
        }

        // 發送文字回覆給使用者
        return client.replyMessage(replyToken, {
          type: 'text',
          text: data.reply
        });
      } else {
        // Apps Script 未回傳有效回覆
        return client.replyMessage(replyToken, {
          type: 'text',
          text: '很抱歉，獲取常見問題時發生錯誤。'
        });
      }
    } catch (error) {
      console.error('Error calling Apps Script for FAQ:', error.message);
      // 捕獲 Apps Script 調用錯誤，並回覆使用者
      return client.replyMessage(replyToken, {
        type: 'text',
        text: '抱歉，處理常見問題時發生系統錯誤。'
      });
    }
  }

  // --- 預約相關邏輯 ---
  if (msg.includes('預約')) {
    // 檢查是否是「我要預約 [日期] [時段]」的格式
    if (msg.includes('我要預約')) {
      try {
        const response = await axios.post(appsScriptUrl, {
          type: 'appointment', // 或你希望 Apps Script 處理的任何類型
          payload: { message: event.message.text }, // 將完整的預約訊息傳送給 Apps Script
          userId: userId
        });

        const data = response.data;
        if (data && data.message) { // 假設 Apps Script 返回 { message: "已收到您的預約..." }
            return client.replyMessage(replyToken, {
                type: 'text',
                text: data.message
            });
        } else {
            return client.replyMessage(replyToken, {
                type: 'text',
                text: '預約請求處理失敗，請稍後再試。'
            });
        }
      } catch (error) {
        console.error('Error calling Apps Script for appointment:', error.message);
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
  // 當沒有匹配任何關鍵字時，回覆使用者輸入的內容
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

