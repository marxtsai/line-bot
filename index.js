'use strict';

// =================================================================
// 【最終版】Node.js 預約系統 (index.js)
// 目的：處理 LINE Webhook，發送預約表單，並將資料轉發至 Google Apps Script
// =================================================================

const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

// --- 配置區塊 (已填入您的資訊) ---
const config = {
    channelAccessToken: 'i44rK1vCf9f9NGu1x/2w1umIY0fvPOrr9n5WLXqIn5anr73xF+Sy6nhuE3D2WMPPY2CeFPHq271St3i3yrmd8bRKhI27XSnFnEH+L1dEej2kcnD6Bo9zXbzbjDy4mCTSFYsny4aLVrBo8X0igHWtIAdB04t89/1O/w1cDnyilFU=',
    channelSecret: 'd52699ba45f0fe91d719b81492cc29dd',
};

// 這是您最新部署的 Google Apps Script (GAS) 網址 (已填入您的資訊)
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxQuU9NprVGnozqSg8HQD1FxB7e8ja0EniuP_-ERTR-OXJaPQpVXemiJuQktTc3KP_b/exec'; 

// --- 程式主要邏輯 ---
const client = new line.Client(config);
const app = express();

// 用於在記憶體中儲存每個使用者的狀態
// 注意：若伺服器重啟 (例如在 Render 上)，此資料會遺失。
const userStates = {};

// LINE Webhook 的路由
app.post('/webhook', line.middleware(config), (req, res) => {
    Promise
        .all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error('Webhook Error:', err);
            res.status(500).end();
        });
});

// 主要事件處理函式
async function handleEvent(event) {
    // 過濾掉非文字訊息和非 postback 事件
    if ((event.type !== 'message' || event.message.type !== 'text') && event.type !== 'postback') {
        return Promise.resolve(null);
    }
    
    // 如果是 postback 事件，直接交給 postback 處理器
    if (event.type === 'postback') {
        return handlePostback(event);
    }

    // --- 以下是處理文字訊息的部分 ---
    const userId = event.source.userId;
    const userMessage = event.message.text.trim();
    const currentState = userStates[userId];

    // 關鍵字 "我要預約" 觸發預約流程
    if (userMessage === '我要預約' && (!currentState || currentState.step !== 'waiting_for_name')) {
        userStates[userId] = {
            step: 'waiting_for_name', // 步驟1: 等待使用者輸入姓名
            name: null,
            date: null,
            time: null,
        };
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: '好的，我們開始進行預約。\n請問您的預約姓名是？'
        });
    }

    // 當系統正在等待使用者輸入姓名時
    if (currentState && currentState.step === 'waiting_for_name') {
        currentState.name = userMessage;
        currentState.step = 'waiting_for_submission'; // 步驟2: 等待表單提交

        const flexMessage = getBookingFlexMessage();
        
        return client.replyMessage(event.replyToken, [
            { type: 'text', text: `好的，${userMessage}！\n請選擇您希望的預約日期與時間。` },
            flexMessage
        ]);
    }
    
    return Promise.resolve(null);
}

// Postback 事件處理器 (處理使用者點擊 Flex Message 按鈕的事件)
async function handlePostback(event) {
    const userId = event.source.userId;
    const postbackData = event.postback.data;
    const currentState = userStates[userId];

    // 解析 postback data，確認 action 是否為 'submit_booking'
    if (postbackData === 'action=submit_booking' && currentState && currentState.step === 'waiting_for_submission') {
        
        // 從 postback 的 params 中取得使用者選擇的日期和時間
        const bookingDate = event.postback.params.date;
        const bookingTime = event.postback.params.time;

        // --- 後端欄位驗證 ---
        if (!currentState.name || !bookingDate || !bookingTime) {
            delete userStates[userId]; // 清除不完整的狀態
            return client.replyMessage(event.replyToken, { 
                type: 'text', 
                text: '抱歉，預約資料不完整（缺少姓名、日期或時間），請重新輸入「我要預約」開始流程。' 
            });
        }
        
        currentState.date = bookingDate;
        currentState.time = bookingTime;

        try {
            // 先回覆一個 "處理中" 的訊息，提升使用者體驗
            await client.replyMessage(event.replyToken, { type: 'text', text: '收到您的預約，正在為您確認時段是否可用...' });

            // 將驗證後的完整資料發送到 Google Apps Script
            const response = await axios.post(GAS_URL, {
                name: currentState.name,
                date: currentState.date,
                time: currentState.time,
            });

            // 清除這位使用者的狀態，完成此趟預約流程
            delete userStates[userId];

            // 根據 Google Apps Script 的回傳結果，用 pushMessage 傳送最終訊息給使用者
            return client.pushMessage(userId, {
                type: 'text',
                text: response.data.message, // 直接使用 GAS 回傳的成功或失敗訊息
            });

        } catch (error) {
            delete userStates[userId]; // 發生錯誤時也要清除狀態
            console.error('Error during GAS communication:', error.response ? error.response.data : error.message);
            // 系統發生錯誤時，回覆一個通用的錯誤訊息
            return client.pushMessage(userId, {
                type: 'text',
                text: '抱歉，預約系統發生了一些問題，請稍後再試或聯絡客服人員。',
            });
        }
    }
    
    return Promise.resolve(null);
}

// 產生預約表單 Flex Message 的函式
function getBookingFlexMessage() {
    return {
      "type": "flex",
      "altText": "AI智慧診所預約表單",
      "contents": {
        "type": "bubble",
        "header": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "text",
              "text": "AI智慧診所預約",
              "weight": "bold",
              "size": "xl",
              "color": "#FFFFFF"
            }
          ],
          "backgroundColor": "#007BFF",
          "paddingAll": "20px"
        },
        "body": {
          "type": "box",
          "layout": "vertical",
          "spacing": "md",
          "contents": [
            {
              "type": "text",
              "text": "請點選下方按鈕，選擇日期與時間",
              "wrap": true,
              "size": "md"
            },
            {
              "type": "separator"
            },
            {
              "type": "box",
              "layout": "horizontal",
              "contents": [
                {
                  "type": "text",
                  "text": "預約日期",
                  "flex": 2,
                  "gravity": "center",
                  "weight": "bold"
                },
                {
                  "type": "button",
                  "action": {
                    "type": "datetimepicker",
                    "label": "選擇日期",
                    "data": "action=select_date",
                    "mode": "date"
                  },
                  "flex": 5,
                  "style": "secondary",
                  "height": "sm"
                }
              ]
            },
            {
              "type": "box",
              "layout": "horizontal",
              "contents": [
                {
                  "type": "text",
                  "text": "預約時間",
                  "flex": 2,
                  "gravity": "center",
                  "weight": "bold"
                },
                {
                  "type": "button",
                  "action": {
                    "type": "datetimepicker",
                    "label": "選擇時間",
                    "data": "action=select_time",
                    "mode": "time"
                  },
                  "flex": 5,
                  "style": "secondary",
                  "height": "sm"
                }
              ]
            }
          ]
        },
        "footer": {
          "type": "box",
          "layout": "vertical",
          "contents": [
            {
              "type": "button",
              "action": {
                "type": "postback",
                "label": "送出預約",
                "data": "action=submit_booking",
                "displayText": "正在為您處理預約..."
              },
              "style": "primary",
              "color": "#007BFF"
            }
          ]
        }
      }
    };
}


// 監聽指定的 port，準備接收來自 LINE 的請求
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
});

