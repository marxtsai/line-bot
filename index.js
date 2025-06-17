// Node.js LINE Bot 主程式 (index.js)
// 目的：處理 LINE Messaging API 的互動，並與 Google Apps Script (GAS) 溝通，
//       實現預約登記、查詢預約、取消預約功能。

'use strict';

const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

// --- 配置區塊 (您的資訊) ---
const config = {
    channelAccessToken: 'i44rK1vCf9f9NGu1x/2w1umIY0fvPOrr9n5WLXqIn5anr73xF+Sy6nhuE3D2WMPPY2CeFPH271St3i3yrmd8bRKhI27XSnFnEH+L1dEej2kcnD6Bo9zXbzbjDy4mCTSFYsny4aLVrBo8X0igHWtIAdB04t89/1O/w1cDnyilFU=', // 請替換為您的 Channel Access Token
    channelSecret: 'd52699ba45f0fe91d719b81492cc29dd', // 請替換為您的 Channel Secret
};

// 這是您部署的 Google Apps Script (GAS) 網址
// 請確保這是您最新部署的 Web App URL
const GAS_URL = 'https://script.google.com/macros/s/AKfycbxQuU9NprVGnozqSg8HQD1FxB7e8ja0EniuP_-ERTR-OXJaPQpVXemiJuQktTc3KP_b/exec';

// --- 程式主要邏輯 ---
const client = new line.Client(config);
const app = express();

// 用於儲存每個使用者的對話狀態
// 狀態包括：
// - step: 當前對話步驟
// - name: 預約者姓名
// - serviceItem: 服務項目
// - date: 預約日期
// - time: 預約時間
// - appointmentToCancelId: 準備取消的預約編號
const userStates = {};

// Webhook 處理入口點
app.post('/webhook', line.middleware(config), (req, res) => {
    Promise
        .all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error('Webhook Error:', err);
            res.status(500).end();
        });
});

/**
 * 處理 LINE Bot 接收到的所有事件。
 * @param {Object} event LINE 事件物件。
 * @returns {Promise<any>} LINE 回覆訊息 Promise。
 */
async function handleEvent(event) {
    // 只處理文字訊息和 Postback 事件
    if ((event.type !== 'message' || event.message.type !== 'text') && event.type !== 'postback') {
        return Promise.resolve(null);
    }

    const userId = event.source.userId;
    const userMessage = event.type === 'message' ? event.message.text.trim() : null;
    let currentState = userStates[userId] || {}; // 確保 currentState 始終存在

    // --- 處理 Postback 事件 (優先處理) ---
    if (event.type === 'postback') {
        return handlePostback(event);
    }

    // --- 處理文字訊息 ---

    // 1. 預約流程開始
    if (userMessage === '我要預約') {
        userStates[userId] = {
            step: 'waiting_for_name',
            name: null,
            serviceItem: null,
            date: null,
            time: null,
        };
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: '好的，我們開始進行預約。\n請問您的預約姓名是？'
        });
    }

    // 2. 處理預約姓名輸入
    if (currentState.step === 'waiting_for_name') {
        currentState.name = userMessage;
        currentState.step = 'waiting_for_service_item'; // 進入新的狀態：等待服務項目
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: `好的，${userMessage}！請問您要預約什麼服務項目？(例如: 洗牙, 拔牙, 補牙)`
        });
    }

    // 3. 處理服務項目輸入
    if (currentState.step === 'waiting_for_service_item') {
        currentState.serviceItem = userMessage;
        currentState.step = 'waiting_for_submission'; // 進入等待日期時間選擇的狀態
        const flexMessage = getBookingFlexMessage();

        return client.replyMessage(event.replyToken, [
            { type: 'text', text: `好的，已記錄服務項目：${userMessage}。\n請選擇您希望的預約日期與時間。` },
            flexMessage
        ]);
    }

    // 4. 查詢預約指令
    if (userMessage === '查詢預約') {
        userStates[userId] = { step: 'querying_appointments' }; // 設定狀態
        await client.replyMessage(event.replyToken, { type: 'text', text: '正在查詢您的預約紀錄，請稍候...' });

        try {
            const response = await axios.post(GAS_URL, {
                action: 'queryAppointments', // 指定 GAS 動作
                userId: userId
            }, { timeout: 25000 }); // 增加超時時間

            const appointments = response.data.data;
            if (appointments && appointments.length > 0) {
                // 顯示查詢結果的 Flex Message
                const flexMessage = getAppointmentsDisplayFlexMessage(appointments);
                return client.pushMessage(userId, flexMessage);
            } else {
                return client.pushMessage(userId, { type: 'text', text: '您目前沒有任何有效的預約紀錄。' });
            }
        } catch (error) {
            console.error('查詢預約時發生錯誤:', error.response ? error.response.data : error.message);
            return client.pushMessage(userId, { type: 'text', text: '查詢預約時發生錯誤，請稍後再試。' });
        } finally {
            delete userStates[userId]; // 完成查詢後清除狀態
        }
    }

    // 5. 取消預約指令
    if (userMessage === '取消預約') {
        userStates[userId] = { step: 'initiating_cancellation' }; // 設定狀態
        await client.replyMessage(event.replyToken, { type: 'text', text: '正在查詢您的預約紀錄以供取消，請稍候...' });

        try {
            const response = await axios.post(GAS_URL, {
                action: 'queryAppointments', // 再次呼叫查詢預約來獲取列表
                userId: userId
            }, { timeout: 25000 });

            const appointments = response.data.data;
            if (appointments && appointments.length > 0) {
                // 顯示可取消預約的 Flex Message
                const flexMessage = getAppointmentsForCancellationFlexMessage(appointments);
                return client.pushMessage(userId, flexMessage);
            } else {
                return client.pushMessage(userId, { type: 'text', text: '您目前沒有任何可取消的預約紀錄。' });
            }
        } catch (error) {
            console.error('查詢可取消預約時發生錯誤:', error.response ? error.response.data : error.message);
            return client.pushMessage(userId, { type: 'text', text: '查詢可取消預約時發生錯誤，請稍後再試。' });
        }
        // 不在這裡清除狀態，因為使用者需要點擊取消按鈕
    }
    
    // 6. 處理「取消操作」訊息 (從取消確認 Flex Message 的返回按鈕觸發)
    if (userMessage === '取消操作' && (currentState.step === 'confirming_cancellation' || currentState.step === 'waiting_for_submission')) {
        delete userStates[userId]; // 清除當前狀態
        return client.replyMessage(event.replyToken, { type: 'text', text: '操作已取消。您可以重新開始。' });
    }

    // 7. 預設回覆：當沒有匹配到任何特定指令或狀態時
    return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '您好，請問需要什麼服務呢？\n您可以輸入「我要預約」、「查詢預約」或「取消預約」。'
    });
}

/**
 * 處理 LINE Bot 接收到的 Postback 事件。
 * @param {Object} event LINE Postback 事件物件。
 * @returns {Promise<any>} LINE 回覆訊息 Promise。
 */
async function handlePostback(event) {
    const userId = event.source.userId;
    const postbackData = event.postback.data;
    let currentState = userStates[userId] || {};

    // 1. 處理日期選擇 (來自 DatetimePicker)
    if (postbackData.startsWith('action=select_date') && event.postback.params && event.postback.params.date) {
        // 只有在等待提交或處理中狀態才允許更新日期
        if (currentState.step === 'waiting_for_submission' || currentState.step === 'processing') {
            currentState.date = event.postback.params.date;
            console.log(`User ${userId} selected date: ${currentState.date}`);
            // 發送即時回饋訊息 (推播訊息，不佔用 replyToken)
            const feedbackText = `📅 已收到你的日期選擇：${currentState.date}\n（提醒你：上方表單畫面不會跟著更新，但系統已成功記錄喔）`;
            return client.pushMessage(userId, { type: 'text', text: feedbackText });
        }
        return Promise.resolve(null);
    }

    // 2. 處理時間選擇 (來自 DatetimePicker)
    if (postbackData.startsWith('action=select_time') && event.postback.params && event.postback.params.time) {
        // 只有在等待提交或處理中狀態才允許更新時間
        if (currentState.step === 'waiting_for_submission' || currentState.step === 'processing') {
            currentState.time = event.postback.params.time;
            console.log(`User ${userId} selected time: ${currentState.time}`);
            // 發送即時回饋訊息 (推播訊息，不佔用 replyToken)
            const feedbackText = `🕒 時間選擇完成：${currentState.time}\n（小提醒：上方表單畫面不會變，但我們這邊已經收到你的選擇了）`;
            return client.pushMessage(userId, { type: 'text', text: feedbackText });
        }
        return Promise.resolve(null);
    }

    // 3. 處理預約提交
    if (postbackData === 'action=submit_booking') {
        if (currentState.step !== 'waiting_for_submission') {
            // 防止重複提交或其他狀態下的誤觸
            return client.replyMessage(event.replyToken, { type: 'text', text: '正在處理您先前的預約，請稍候...' });
        }

        const { name, serviceItem, date, time } = currentState; // 解構使用者狀態中的所有必要資訊

        if (!name || !serviceItem || !date || !time) {
            // 提醒使用者缺少完整資訊
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: '抱歉，您尚未選擇完整的預約資訊（姓名、服務項目、日期或時間），請在表單上點選後再送出。'
            });
        }

        currentState.step = 'processing'; // 進入處理中狀態，防止重複提交

        try {
            await client.replyMessage(event.replyToken, { type: 'text', text: '收到您的預約，正在為您確認時段是否可用...' });

            // 發送 POST 請求到 Google Apps Script
            const response = await axios.post(GAS_URL, {
                action: 'bookAppointment', // 指定要執行的 GAS 動作
                name: name,
                date: date,
                time: time,
                userId: userId, // 傳遞 LINE User ID
                serviceItem: serviceItem // 傳遞服務項目
            }, { timeout: 25000 }); // 設置超時時間

            delete userStates[userId]; // 完成流程，刪除使用者狀態

            // 回覆使用者 GAS 返回的訊息
            return client.pushMessage(userId, {
                type: 'text',
                text: response.data.message,
            });

        } catch (error) {
            delete userStates[userId]; // 發生錯誤也清除狀態
            console.error('與 GAS 通訊發生錯誤 (預約提交):', error.response ? error.response.data : error.message);

            // 根據 GAS 的錯誤訊息給予更精確的回覆
            let errorMessage = '抱歉，預約系統發生了一些問題，請稍後再試或聯絡客服人員。';
            if (error.response && error.response.data && error.response.data.message) {
                errorMessage = error.response.data.message; // 使用 GAS 返回的錯誤訊息
            }

            return client.pushMessage(userId, {
                type: 'text',
                text: errorMessage,
            });
        }
    }

    // 4. 處理「取消此預約」按鈕點擊 (從 getAppointmentsForCancellationFlexMessage)
    if (postbackData.startsWith('action=cancel_selected_appointment')) {
        const appointmentId = postbackData.split('&')[1].split('=')[1]; // 從 postback data 中解析預約編號
        userStates[userId] = { step: 'confirming_cancellation', appointmentToCancelId: appointmentId }; // 儲存待取消的預約編號

        // 提供取消確認訊息
        const confirmationText = `您確定要取消預約編號 **${appointmentId}** 嗎？\n點擊「確認取消」後將無法復原。`;
        const flexMessage = getCancelConfirmationFlexMessage(appointmentId, confirmationText); // 傳遞預約編號到確認訊息

        return client.replyMessage(event.replyToken, flexMessage);
    }

    // 5. 處理「確認取消」按鈕點擊
    if (postbackData.startsWith('action=confirm_cancel')) {
        const appointmentId = postbackData.split('&')[1].split('=')[1]; // 從 postback data 中解析預約編號

        // 驗證狀態和預約編號是否一致，防止亂點或過期請求
        if (currentState.step === 'confirming_cancellation' && currentState.appointmentToCancelId === appointmentId) {
            currentState.step = 'processing'; // 設定為處理中狀態，防止重複提交

            try {
                await client.replyMessage(event.replyToken, { type: 'text', text: `正在為您取消預約 ${appointmentId}，請稍候...` });

                // 發送 POST 請求到 Google Apps Script
                const response = await axios.post(GAS_URL, {
                    action: 'cancelAppointment', // 指定要執行的 GAS 動作
                    appointmentId: appointmentId,
                    userId: userId // 傳遞 LINE User ID 進行驗證
                }, { timeout: 25000 }); // 設置超時時間

                delete userStates[userId]; // 完成流程，刪除使用者狀態

                // 回覆使用者 GAS 返回的訊息
                return client.pushMessage(userId, {
                    type: 'text',
                    text: response.data.message,
                });

            } catch (error) {
                delete userStates[userId]; // 發生錯誤也清除狀態
                console.error('與 GAS 通訊發生錯誤 (取消預約):', error.response ? error.response.data : error.message);

                let errorMessage = '取消預約時發生錯誤，請稍後再試。';
                if (error.response && error.response.data && error.response.data.message) {
                    errorMessage = error.response.data.message; // 使用 GAS 返回的錯誤訊息
                }

                return client.pushMessage(userId, {
                    type: 'text',
                    text: errorMessage,
                });
            }
        } else {
            return client.replyMessage(event.replyToken, { type: 'text', text: '無效的操作或您的取消請求已過期，請重新開始。' });
        }
    }

    return Promise.resolve(null); // 如果沒有匹配到任何 postback，則不回覆
}

/**
 * 生成預約日期與時間選擇的 Flex Message。
 * @returns {Object} Flex Message 物件。
 */
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
                    { "type": "text", "text": "AI智慧診所預約", "weight": "bold", "size": "xl", "color": "#FFFFFF" }
                ],
                "backgroundColor": "#007BFF",
                "paddingAll": "20px"
            },
            "body": {
                "type": "box",
                "layout": "vertical",
                "spacing": "md",
                "contents": [
                    { "type": "text", "text": "請點選下方按鈕，選擇日期與時間", "wrap": true, "size": "md" },
                    { "type": "separator" },
                    {
                        "type": "box",
                        "layout": "horizontal",
                        "contents": [
                            { "type": "text", "text": "預約日期", "flex": 2, "gravity": "center", "weight": "bold" },
                            { "type": "button", "action": { "type": "datetimepicker", "label": "選擇日期", "data": "action=select_date", "mode": "date" }, "flex": 5, "style": "secondary", "height": "sm" }
                        ]
                    },
                    {
                        "type": "box",
                        "layout": "horizontal",
                        "contents": [
                            { "type": "text", "text": "預約時間", "flex": 2, "gravity": "center", "weight": "bold" },
                            { "type": "button", "action": { "type": "datetimepicker", "label": "選擇時間", "data": "action=select_time", "mode": "time" }, "flex": 5, "style": "secondary", "height": "sm" }
                        ]
                    }
                ]
            },
            "footer": {
                "type": "box",
                "layout": "vertical",
                "contents": [
                    { "type": "button", "action": { "type": "postback", "label": "送出預約", "data": "action=submit_booking", "displayText": "正在為您處理預約..." }, "style": "primary", "color": "#007BFF" }
                ]
            }
        }
    };
}

/**
 * 生成顯示預約列表的 Flex Message (Carousel)。
 * @param {Array<Object>} appointments 預約紀錄陣列。
 * @returns {Object} Flex Message 物件。
 */
function getAppointmentsDisplayFlexMessage(appointments) {
    if (!appointments || appointments.length === 0) {
        return { type: 'text', text: '您目前沒有任何有效的預約紀錄。' };
    }

    const bubbles = appointments.map(appt => {
        return {
            type: 'bubble',
            body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'md',
                contents: [
                    { type: 'text', text: `✅ 您的預約紀錄`, weight: 'bold', size: 'md', color: '#1a73e8' },
                    { type: 'separator', margin: 'md' },
                    { type: 'text', text: `預約編號: ${appt['預約編號']}`, wrap: true, size: 'sm' },
                    { type: 'text', text: `姓名: ${appt['姓名']}`, wrap: true, size: 'sm' },
                    { type: 'text', text: `服務項目: ${appt['服務項目']}`, wrap: true, size: 'sm' },
                    { type: 'text', text: `日期: ${appt['預約日期']}`, wrap: true, size: 'sm' },
                    { type: 'text', text: `時間: ${appt['預約時間']}`, wrap: true, size: 'sm' }
                ]
            }
        };
    });

    return {
        type: 'flex',
        altText: '您的預約紀錄',
        contents: {
            type: 'carousel',
            contents: bubbles.slice(0, 10) // 輪播最多顯示 10 個預約
        }
    };
}

/**
 * 生成帶有取消按鈕的預約列表 Flex Message (Carousel)。
 * @param {Array<Object>} appointments 預約紀錄陣列。
 * @returns {Object} Flex Message 物件。
 */
function getAppointmentsForCancellationFlexMessage(appointments) {
    if (!appointments || appointments.length === 0) {
        return { type: 'text', text: '您目前沒有任何可取消的預約紀錄。' };
    }

    const bubbles = appointments.map(appt => {
        return {
            type: 'bubble',
            body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'md',
                contents: [
                    { type: 'text', text: `🗑️ 取消預約`, weight: 'bold', size: 'md', color: '#DC3545' },
                    { type: 'separator', margin: 'md' },
                    { type: 'text', text: `預約編號: ${appt['預約編號']}`, wrap: true, size: 'sm' },
                    { type: 'text', text: `姓名: ${appt['姓名']}`, wrap: true, size: 'sm' },
                    { type: 'text', text: `服務項目: ${appt['服務項目']}`, wrap: true, size: 'sm' },
                    { type: 'text', text: `日期: ${appt['預約日期']}`, wrap: true, size: 'sm' },
                    { type: 'text', text: `時間: ${appt['預約時間']}`, wrap: true, size: 'sm' },
                    {
                        type: 'button',
                        action: {
                            type: 'postback',
                            label: '取消此預約',
                            data: `action=cancel_selected_appointment&id=${appt['預約編號']}`,
                            displayText: `正在為您準備取消預約 ${appt['預約編號']}...`
                        },
                        style: 'primary',
                        color: '#DC3545', // 取消按鈕使用紅色
                        margin: 'md'
                    }
                ]
            }
        };
    });

    return {
        type: 'flex',
        altText: '選擇要取消的預約',
        contents: {
            type: 'carousel',
            contents: bubbles.slice(0, 10) // 輪播最多顯示 10 個預約
        }
    };
}

/**
 * 生成取消預約確認的 Flex Message。
 * @param {string} appointmentId 預約編號。
 * @param {string} confirmationText 顯示的確認文字。
 * @returns {Object} Flex Message 物件。
 */
function getCancelConfirmationFlexMessage(appointmentId, confirmationText) {
    return {
        type: 'flex',
        altText: '確認取消預約',
        contents: {
            type: 'bubble',
            body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'md',
                contents: [
                    { type: 'text', text: confirmationText, wrap: true, align: 'center', size: 'md', weight: 'bold', color: '#333333' },
                    {
                        type: 'button',
                        action: {
                            type: 'postback',
                            label: '確認取消',
                            data: `action=confirm_cancel&id=${appointmentId}`,
                            displayText: `正在取消預約 ${appointmentId}...`
                        },
                        style: 'primary',
                        color: '#DC3545', // 確認取消按鈕使用紅色
                        margin: 'lg'
                    },
                    {
                        type: 'button',
                        action: {
                            type: 'message', // 發送一個文字訊息回 Bot，讓 Bot 清除狀態
                            label: '返回 / 取消操作',
                            text: '取消操作'
                        },
                        style: 'secondary',
                        color: '#6c757d',
                        margin: 'md'
                    }
                ]
            }
        }
    };
}


const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
});
