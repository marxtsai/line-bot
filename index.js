'use strict';

// =================================================================
// 【修正版】Node.js 預約系統 (index.js)
// 修正了 postback 事件的處理邏輯，確保能正確儲存並發送預約資料
// =================================================================

const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

// --- 配置區塊 (您的資訊) ---
const config = {
    channelAccessToken: 'i44rK1vCf9f9NGu1x/2w1umIY0fvPOrr9n5WLXqIn5anr73xF+Sy6nhuE3D2WMPPY2CeFPHq271St3i3yrmd8bRKhI27XSnFnEH+L1dEej2kcnD6Bo9zXbzbjDy4mCTSFYsny4aLVrBo8X0igHWtIAdB04t89/1O/w1cDnyilFU=',
    channelSecret: 'd52699ba45f0fe91d719b81492cc29dd',
};

// 這是您最新部署的 Google Apps Script (GAS) 網址
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxQuU9NprVGnozqSg8HQD1FxB7e8ja0EniuP_-ERTR-OXJaPQpVXemiJuQktTc3KP_b/exec'; 

// --- 程式主要邏輯 ---
const client = new line.Client(config);
const app = express();

// 用於在記憶體中儲存每個使用者的狀態
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
    if ((event.type !== 'message' || event.message.type !== 'text') && event.type !== 'postback') {
        return Promise.resolve(null);
    }
    
    if (event.type === 'postback') {
        return handlePostback(event);
    }

    const userId = event.source.userId;
    const userMessage = event.message.text.trim();
    const currentState = userStates[userId];

    if (userMessage === '我要預約' && (!currentState || currentState.step !== 'waiting_for_name')) {
        userStates[userId] = {
            step: 'waiting_for_name',
            name: null,
            date: null,
            time: null,
        };
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: '好的，我們開始進行預約。\n請問您的預約姓名是？'
        });
    }

    if (currentState && currentState.step === 'waiting_for_name') {
        currentState.name = userMessage;
        currentState.step = 'waiting_for_submission';
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

    if (!currentState || currentState.step !== 'waiting_for_submission') {
        return Promise.resolve(null); // 如果使用者不在預約流程中，則忽略
    }

    // --- 【修正後的邏輯】 ---
    // 情況一：使用者選擇了日期
    if (postbackData === 'action=select_date' && event.postback.params && event.postback.params.date) {
        currentState.date = event.postback.params.date;
        console.log(`User ${userId} selected date: ${currentState.date}`);
        // 不需要回覆訊息，LINE 會自動處理
        return Promise.resolve(null);
    }

    // 情況二：使用者選擇了時間
    if (postbackData === 'action=select_time' && event.postback.params && event.postback.params.time) {
        currentState.time = event.postback.params.time;
        console.log(`User ${userId} selected time: ${currentState.time}`);
        // 不需要回覆訊息
        return Promise.resolve(null);
    }

    // 情況三：使用者按下「送出預約」
    if (postbackData === 'action=submit_booking') {
        // 從我們自己儲存的狀態中取得姓名、日期、時間
        const { name, date, time } = currentState;

        // 後端欄位驗證 (現在更重要了)
        if (!name || !date || !time) {
            return client.replyMessage(event.replyToken, { 
                type: 'text', 
                text: '抱歉，您尚未選擇完整的預約資訊（日期或時間），請在表單上點選後再送出。' 
            });
        }
        
        try {
            await client.replyMessage(event.replyToken, { type: 'text', text: '收到您的預約，正在為您確認時段是否可用...' });

            const response = await axios.post(GAS_URL, { name, date, time });

            delete userStates[userId]; // 清除狀態，完成預約

            return client.pushMessage(userId, {
                type: 'text',
                text: response.data.message,
            });

        } catch (error) {
            delete userStates[userId];
            console.error('Error during GAS communication:', error.response ? error.response.data : error.message);
            
            return client.pushMessage(userId, {
                type: 'text',
                text: '抱歉，預約系統發生了一些問題，請稍後再試或聯絡客服人員。',
            });
        }
    }
    
    return Promise.resolve(null);
}

// 產生預約表單 Flex Message 的函式 (此函式無須變動)
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
                    "data": "action=select_date", // 送出 postback
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
                    "data": "action=select_time", // 送出 postback
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
                "data": "action=submit_booking", // 送出 postback
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


// 監聽指定的 port
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
});
