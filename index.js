'use strict';

// =================================================================
// 【最終完美版】Node.js 預約系統 (index.js)
// 1. 新增：選擇日期/時間後，發送即時文字回饋。
// 2. 保留：增加 axios 請求超時時間，提高對 GAS 冷啟動的容錯率。
// 3. 保留：增加 "processing" 狀態，防止使用者重複提交預約。
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

const userStates = {};

app.post('/webhook', line.middleware(config), (req, res) => {
    Promise
        .all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error('Webhook Error:', err);
            res.status(500).end();
        });
});

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

    if (userMessage === '我要預約') {
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

async function handlePostback(event) {
    const userId = event.source.userId;
    const postbackData = event.postback.data;
    const currentState = userStates[userId];

    if (!currentState) return Promise.resolve(null);

    // 【新功能】處理日期選擇
    if (postbackData.startsWith('action=select_date') && event.postback.params && event.postback.params.date) {
        if (currentState.step === 'waiting_for_submission' || currentState.step === 'processing') {
             currentState.date = event.postback.params.date;
             console.log(`User ${userId} selected date: ${currentState.date}`);
             // 發送即時回饋訊息
             const feedbackText = `📅 已收到你的日期選擇：${currentState.date}\n（提醒你：上方表單畫面不會跟著更新，但系統已成功記錄喔）`;
             return client.pushMessage(userId, { type: 'text', text: feedbackText });
        }
        return Promise.resolve(null);
    }

    // 【新功能】處理時間選擇
    if (postbackData.startsWith('action=select_time') && event.postback.params && event.postback.params.time) {
         if (currentState.step === 'waiting_for_submission' || currentState.step === 'processing') {
            currentState.time = event.postback.params.time;
            console.log(`User ${userId} selected time: ${currentState.time}`);
            // 發送即時回饋訊息
            const feedbackText = `🕒 時間選擇完成：${currentState.time}\n（小提醒：上方表單畫面不會變，但我們這邊已經收到你的選擇了）`;
            return client.pushMessage(userId, { type: 'text', text: feedbackText });
        }
        return Promise.resolve(null);
    }

    // 處理最終提交
    if (postbackData === 'action=submit_booking') {
        if (currentState.step !== 'waiting_for_submission') {
            return client.replyMessage(event.replyToken, { type: 'text', text: '正在處理您先前的預約，請稍候...' });
        }

        const { name, date, time } = currentState;

        if (!name || !date || !time) {
            return client.replyMessage(event.replyToken, { 
                type: 'text', 
                text: '抱歉，您尚未選擇完整的預約資訊（日期或時間），請在表單上點選後再送出。' 
            });
        }

        currentState.step = 'processing'; // 進入處理中狀態，防止重複提交
        
        try {
            await client.replyMessage(event.replyToken, { type: 'text', text: '收到您的預約，正在為您確認時段是否可用...' });
            
            const response = await axios.post(GAS_URL, { name, date, time }, { timeout: 25000 });

            delete userStates[userId]; // 完成流程，刪除狀態

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

function getBookingFlexMessage() {
    return {"type":"flex","altText":"AI智慧診所預約表單","contents":{"type":"bubble","header":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"AI智慧診所預約","weight":"bold","size":"xl","color":"#FFFFFF"}],"backgroundColor":"#007BFF","paddingAll":"20px"},"body":{"type":"box","layout":"vertical","spacing":"md","contents":[{"type":"text","text":"請點選下方按鈕，選擇日期與時間","wrap":true,"size":"md"},{"type":"separator"},{"type":"box","layout":"horizontal","contents":[{"type":"text","text":"預約日期","flex":2,"gravity":"center","weight":"bold"},{"type":"button","action":{"type":"datetimepicker","label":"選擇日期","data":"action=select_date","mode":"date"},"flex":5,"style":"secondary","height":"sm"}]},{"type":"box","layout":"horizontal","contents":[{"type":"text","text":"預約時間","flex":2,"gravity":"center","weight":"bold"},{"type":"button","action":{"type":"datetimepicker","label":"選擇時間","data":"action=select_time","mode":"time"},"flex":5,"style":"secondary","height":"sm"}]}]},"footer":{"type":"box","layout":"vertical","contents":[{"type":"button","action":{"type":"postback","label":"送出預約","data":"action=submit_booking","displayText":"正在為您處理預約..."},"style":"primary","color":"#007BFF"}]}}};
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
});