const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: 'UF2P/f6qluwyT2D6ieAB/7FLixf7x72SyPsSpMTtdeGtUsDev7lTByXHMlMvp7XEY2CeFPHq271St3i3yrmd8bRKhI27XSnFnEH+L1dEej1JxBdMH2zUbWK+d8qLmT3SR4VXnqDXp2q08rWqvFRIDgdB04t89/1O/w1cDnyilFU=',
  channelSecret: 'ef129f320d287a79f5579f5801a74368',
};

const client = new line.Client(config);
const app = express();

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhook 處理錯誤:', err);
      res.status(500).end();
    });
});

function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text.toLowerCase();
  console.log("使用者輸入：", userMessage);

  if (userMessage.includes('faq')) {
    const flexMessage = {
      type: 'flex',
      altText: '常見問題卡片',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: '常見問題：營業時間',
              weight: 'bold',
              size: 'md',
              wrap: true,
            },
            {
              type: 'text',
              text: '我們每日 10:00–20:00 營業',
              size: 'sm',
              margin: 'md',
              wrap: true,
            }
          ],
        },
        footer: {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              style: 'link',
              height: 'sm',
              action: {
                type: 'uri',
                label: '查看更多 FAQ',
                uri: 'https://your-website.com/faq'
              }
            }
          ],
          flex: 0
        }
      }
    };

    return client.replyMessage(event.replyToken, flexMessage);
  }

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `你說的是：「${userMessage}」`,
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`LINE bot 伺服器運行中，port: ${port}`);
});

