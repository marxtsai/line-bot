const express = require('express');
const line = require('@line/bot-sdk');

// LINE bot 設定（已內建你的 Sensist-591 資訊）
const config = {
  channelAccessToken: 'UF2P/f6qluwyT2D6ieAB/7FLixf7x72SyPsSpMTtdeGtUsDev7lTByXHMlMvp7XEY2CeFPHq271St3i3yrmd8bRKhI27XSnFnEH+L1dEej1JxBdMH2zUbWK+d8qLmT3SR4VXnqDXp2q08rWqvFRIDgdB04t89/1O/w1cDnyilFU=',
  channelSecret: 'ef129f320d287a79f5579f5801a74368',
};

// 建立 LINE client
const client = new line.Client(config);

// 建立 express 應用程式
const app = express();

// 處理來自 LINE 的 Webhook POST 請求
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook 處理錯誤:', err);
      res.status(500).end();
    });
});

// 單一事件的處理函式
function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;

  // 回覆原始訊息
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `你說的是：「${userMessage}」`,
  });
}

// 設定本地測試 port（Render 上不會用到這個）
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE bot 伺服器運行中，port: ${port}`);
});
