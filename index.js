// Node.js LINE Bot 主程式 (index.js)
// 目的：處理 LINE Messaging API 的互動，並與 Google Apps Script (GAS) 溝通，
//        實現預約登記、查詢預約、取消預約功能。
// ***此版本使用環境變數來管理敏感資訊和 GAS URL***

'use strict';

const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

// --- 配置區塊 (從環境變數讀取資訊) ---
const config = {
    // 從環境變數 LINE_CHANNEL_ACCESS_TOKEN 讀取 Channel Access Token
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    // 從環境變數 LINE_CHANNEL_SECRET 讀取 Channel Secret
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// 從環境變數 GAS_WEB_APP_URL 讀取 Google Apps Script 網址
const GAS_URL = process.env.GAS_WEB_APP_URL;

// 檢查必要的環境變數是否存在
if (!config.channelAccessToken || !config.channelSecret || !GAS_URL) {
    console.error('錯誤：缺少必要的環境變數。請設定 LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET 和 GAS_WEB_APP_URL。');
    // 在生產環境中，可以考慮在此處退出進程
    process.exit(1);
}

// --- 程式主要邏輯 ---
const client = new line.Client(config);
const app = express();

// 用於儲存每個使用者的對話狀態
// 注意：這種記憶體內的狀態管理在伺服器重啟或多實例部署時會丟失。
// MVP V1.0 階段可以接受，未來 V2.0+ 可考慮整合資料庫持久化。
const userStates = {};

// Webhook 處理入口點
// LINE SDK 中間件會自動驗證請求來源並解析事件
app.post('/webhook', line.middleware(config), (req, res) => {
    // 遍歷所有收到的 LINE 事件並處理
    Promise
        .all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error('Webhook 處理錯誤:', err);
            // 由於 LINE Bot SDK 可能拋出 401 (Unauthorized) 錯誤，
            // 應檢查 channelAccessToken 和 channelSecret 是否正確。
            res.status(500).end(); // 回覆 500 狀態碼表示伺服器內部錯誤
        });
});

/**
 * 處理 LINE Bot 接收到的所有事件。
 * 支援 'message' (文字訊息) 和 'postback' 事件。
 * @param {Object} event LINE 事件物件。
 * @returns {Promise<any>} LINE 回覆訊息 Promise。
 */
async function handleEvent(event) {
    // 僅處理文字訊息和 Postback 事件，忽略其他事件類型
    if ((event.type !== 'message' || event.message.type !== 'text') && event.type !== 'postback') {
        console.log(`忽略的事件類型: ${event.type}`);
        return Promise.resolve(null);
    }

    const userId = event.source.userId;
    // 根據事件類型獲取用戶訊息，postback 事件沒有 message.text
    const userMessage = event.type === 'message' ? event.message.text.trim() : null;
    // 從 userStates 中獲取或初始化用戶的對話狀態
    let currentState = userStates[userId] || {};

    // --- 優先處理 Postback 事件 ---
    if (event.type === 'postback') {
        return handlePostback(event);
    }

    // --- 處理文字訊息 ---

    // 1. 預約流程開始：用戶輸入 "我要預約"
    if (userMessage === '我要預約') {
        // 初始化或重置用戶狀態為預約流程的第一步
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

    // 2. 處理預約姓名輸入：如果當前步驟是等待姓名
    if (currentState.step === 'waiting_for_name') {
        currentState.name = userMessage; // 儲存用戶輸入的姓名
        currentState.step = 'waiting_for_service_item'; // 進入下一步：等待服務項目
        return client.replyMessage(event.replyToken, {
            type: 'text',
            text: `好的，${userMessage}！請問您要預約什麼服務項目？(例如: 洗牙, 拔牙, 補牙)`
        });
    }

    // 3. 處理服務項目輸入：如果當前步驟是等待服務項目
    if (currentState.step === 'waiting_for_service_item') {
        currentState.serviceItem = userMessage; // 儲存用戶輸入的服務項目
        currentState.step = 'waiting_for_submission'; // 進入下一步：等待日期時間選擇
        const flexMessage = getBookingFlexMessage(); // 生成預約表單 Flex Message

        return client.replyMessage(event.replyToken, [
            { type: 'text', text: `好的，已記錄服務項目：${userMessage}。\n請選擇您希望的預約日期與時間。` },
            flexMessage // 發送預約表單
        ]);
    }

    // 4. 查詢預約指令：用戶輸入 "查詢預約"
    if (userMessage === '查詢預約') {
        userStates[userId] = { step: 'querying_appointments' }; // 設定狀態為查詢中
        await client.replyMessage(event.replyToken, { type: 'text', text: '正在查詢您的預約紀錄，請稍候...' });

        try {
            // 向 GAS 發送查詢預約請求
            const response = await axios.post(GAS_URL, {
                action: 'queryAppointments', // GAS 中對應的動作名稱
                userId: userId // 傳遞用戶 ID 進行查詢
            }, { timeout: 25000 }); // 設定請求超時時間

            const appointments = response.data.data; // 從 GAS 回覆中獲取預約數據
            if (appointments && appointments.length > 0) {
                // 如果有預約，生成並發送顯示預約列表的 Flex Message
                const flexMessage = getAppointmentsDisplayFlexMessage(appointments);
                return client.pushMessage(userId, flexMessage); // 使用 pushMessage 因為 replyToken 可能已過期
            } else {
                // 如果沒有預約，發送文字訊息告知
                return client.pushMessage(userId, { type: 'text', text: '您目前沒有任何有效的預約紀錄。' });
            }
        } catch (error) {
            console.error('查詢預約時發生錯誤:', error.response ? error.response.data : error.message);
            // 發生錯誤時，告知用戶
            return client.pushMessage(userId, { type: 'text', text: '查詢預約時發生錯誤，請稍後再試。' });
        } finally {
            delete userStates[userId]; // 完成查詢後清除用戶狀態
        }
    }

    // 5. 取消預約指令：用戶輸入 "取消預約"
    if (userMessage === '取消預約') {
        userStates[userId] = { step: 'initiating_cancellation' }; // 設定狀態為準備取消
        await client.replyMessage(event.replyToken, { type: 'text', text: '正在查詢您的預約紀錄以供取消，請稍候...' });

        try {
            // 再次向 GAS 發送查詢預約請求，獲取可供取消的列表
            const response = await axios.post(GAS_URL, {
                action: 'queryAppointments',
                userId: userId
            }, { timeout: 25000 });

            const appointments = response.data.data;
            if (appointments && appointments.length > 0) {
                // 如果有預約，生成並發送帶有取消按鈕的 Flex Message
                const flexMessage = getAppointmentsForCancellationFlexMessage(appointments);
                return client.pushMessage(userId, flexMessage); // 使用 pushMessage
            } else {
                // 如果沒有可取消預約，發送文字訊息告知
                return client.pushMessage(userId, { type: 'text', text: '您目前沒有任何可取消的預約紀錄。' });
            }
        } catch (error) {
            console.error('查詢可取消預約時發生錯誤:', error.response ? error.response.data : error.message);
            // 發生錯誤時，告知用戶
            return client.pushMessage(userId, { type: 'text', text: '查詢可取消預約時發生錯誤，請稍後再試。' });
        }
        // 此處不清除狀態，因為用戶需要透過點擊按鈕來完成取消流程
    }
    
    // 6. 處理「取消操作」訊息：用戶點擊 Flex Message 中的 "取消操作" 按鈕
    if (userMessage === '取消操作' && (currentState.step === 'confirming_cancellation' || currentState.step === 'waiting_for_submission')) {
        delete userStates[userId]; // 清除當前用戶狀態
        return client.replyMessage(event.replyToken, { type: 'text', text: '操作已取消。您可以重新開始。' });
    }

    // 7. 預設回覆：當用戶輸入的訊息沒有匹配到任何特定指令或當前狀態時
    return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '您好，請問需要什麼服務呢？\n您可以輸入「我要預約」、「查詢預約」或「取消預約」。'
    });
}

/**
 * 處理 LINE Bot 接收到的 Postback 事件。
 * 主要用於處理日期時間選擇器和 Flex Message 按鈕回傳的數據。
 * @param {Object} event LINE Postback 事件物件。
 * @returns {Promise<any>} LINE 回覆訊息 Promise。
 */
async function handlePostback(event) {
    const userId = event.source.userId;
    const postbackData = event.postback.data; // 從 postback 事件中獲取數據
    let currentState = userStates[userId] || {}; // 獲取或初始化用戶狀態

    // 1. 處理日期選擇 (來自 DatetimePicker)：數據以 "action=select_date" 開頭
    if (postbackData.startsWith('action=select_date') && event.postback.params && event.postback.params.date) {
        // 僅在預約提交或處理中狀態下允許更新日期，防止誤操作
        if (currentState.step === 'waiting_for_submission' || currentState.step === 'processing') {
            currentState.date = event.postback.params.date; // 儲存選擇的日期
            console.log(`用戶 ${userId} 選擇日期: ${currentState.date}`);
            // 發送即時回饋訊息給用戶 (使用 pushMessage，不佔用 replyToken)
            const feedbackText = `📅 已收到你的日期選擇：${currentState.date}\n（提醒你：上方表單畫面不會跟著更新，但系統已成功記錄喔）`;
            return client.pushMessage(userId, { type: 'text', text: feedbackText });
        }
        return Promise.resolve(null); // 如果狀態不符，不進行處理
    }

    // 2. 處理時間選擇 (來自 DatetimePicker)：數據以 "action=select_time" 開頭
    if (postbackData.startsWith('action=select_time') && event.postback.params && event.postback.params.time) {
        // 僅在預約提交或處理中狀態下允許更新時間
        if (currentState.step === 'waiting_for_submission' || currentState.step === 'processing') {
            currentState.time = event.postback.params.time; // 儲存選擇的時間
            console.log(`用戶 ${userId} 選擇時間: ${currentState.time}`);
            // 發送即時回饋訊息
            const feedbackText = `🕒 時間選擇完成：${currentState.time}\n（小提醒：上方表單畫面不會變，但我們這邊已經收到你的選擇了）`;
            return client.pushMessage(userId, { type: 'text', text: feedbackText });
        }
        return Promise.resolve(null); // 如果狀態不符，不進行處理
    }

    // 3. 處理預約提交：數據為 "action=submit_booking"
    if (postbackData === 'action=submit_booking') {
        // 檢查當前狀態是否為等待提交，防止重複提交
        if (currentState.step !== 'waiting_for_submission') {
            return client.replyMessage(event.replyToken, { type: 'text', text: '正在處理您先前的預約，請稍候...' });
        }

        const { name, serviceItem, date, time } = currentState; // 從用戶狀態中獲取所有預約信息

        // 檢查所有必要信息是否都已填寫
        if (!name || !serviceItem || !date || !time) {
            return client.replyMessage(event.replyToken, {
                type: 'text',
                text: '抱歉，您尚未選擇完整的預約資訊（姓名、服務項目、日期或時間），請在表單上點選後再送出。'
            });
        }

        currentState.step = 'processing'; // 將狀態設定為處理中，防止用戶重複提交

        try {
            await client.replyMessage(event.replyToken, { type: 'text', text: '收到您的預約，正在為您確認時段是否可用...' });

            // 向 Google Apps Script 發送預約請求
            const response = await axios.post(GAS_URL, {
                action: 'bookAppointment', // GAS 中對應的動作名稱
                name: name,
                date: date,
                time: time,
                userId: userId, // 傳遞 LINE 用戶 ID
                serviceItem: serviceItem // 傳遞服務項目
            }, { timeout: 25000 }); // 設定請求超時時間

            delete userStates[userId]; // 預約成功或失敗後，清除用戶狀態

            // 回覆用戶 GAS 返回的訊息 (成功或失敗的提示)
            return client.pushMessage(userId, {
                type: 'text',
                text: response.data.message,
            });

        } catch (error) {
            delete userStates[userId]; // 發生錯誤時也清除用戶狀態
            console.error('與 GAS 通訊發生錯誤 (預約提交):', error.response ? error.response.data : error.message);

            // 根據 GAS 的錯誤訊息給予用戶更精確的回覆
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

    // 4. 處理「取消此預約」按鈕點擊：數據以 "action=cancel_selected_appointment" 開頭
    if (postbackData.startsWith('action=cancel_selected_appointment')) {
        // 從 postback data 中解析預約編號
        const appointmentId = postbackData.split('&')[1].split('=')[1];
        // 儲存待取消的預約編號並設定狀態
        userStates[userId] = { step: 'confirming_cancellation', appointmentToCancelId: appointmentId };

        // 提供取消確認訊息給用戶
        const confirmationText = `您確定要取消預約編號 **${appointmentId}** 嗎？\n點擊「確認取消」後將無法復原。`;
        const flexMessage = getCancelConfirmationFlexMessage(appointmentId, confirmationText); // 生成確認 Flex Message

        return client.replyMessage(event.replyToken, flexMessage); // 回覆確認訊息
    }

    // 5. 處理「確認取消」按鈕點擊：數據以 "action=confirm_cancel" 開頭
    if (postbackData.startsWith('action=confirm_cancel')) {
        // 從 postback data 中解析預約編號
        const appointmentId = postbackData.split('&')[1].split('=')[1];

        // 驗證當前狀態和待取消的預約編號是否匹配，防止無效或重複請求
        if (currentState.step === 'confirming_cancellation' && currentState.appointmentToCancelId === appointmentId) {
            currentState.step = 'processing'; // 設定狀態為處理中

            try {
                await client.replyMessage(event.replyToken, { type: 'text', text: `正在為您取消預約 ${appointmentId}，請稍候...` });

                // 向 Google Apps Script 發送取消預約請求
                const response = await axios.post(GAS_URL, {
                    action: 'cancelAppointment', // GAS 中對應的動作名稱
                    appointmentId: appointmentId,
                    userId: userId // 傳遞 LINE 用戶 ID 進行驗證
                }, { timeout: 25000 }); // 設定請求超時時間

                delete userStates[userId]; // 取消成功或失敗後，清除用戶狀態

                // 回覆用戶 GAS 返回的訊息
                return client.pushMessage(userId, {
                    type: 'text',
                    text: response.data.message,
                });

            } catch (error) {
                delete userStates[userId]; // 發生錯誤時也清除用戶狀態
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
            // 如果狀態不匹配或請求無效，告知用戶
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


// 從環境變數中獲取端口號，如果沒有設定，則預設使用 3000
// Render 會自動設定 PORT 環境變數
const port = process.env.PORT || 3000;
// 啟動伺服器並監聽指定端口
app.listen(port, () => {
    console.log(`Node.js 伺服器正在端口 ${port} 上運行。`);
    console.log(`LINE Webhook 端點: /webhook`);
});
