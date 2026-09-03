# TeamAsk

团队 AI 问答空间：支持多人并行向 AI 提问。姓名、会话、消息和 AI 配置统一保存在部署机器的 `data/state.json`，浏览器仅保留用于识别访问者的匿名 Cookie。

应用仅调用 OpenAI 兼容的 `/chat/completions`，使用标准 `messages` 格式。每个会话只保留最近一次完整请求和响应用于调试，其中 API Key 会脱敏。

请运行 `./start.sh` 启动本地页面和 AI 代理。点击右上角设置填写 API 基础地址、Key 和模型名；浏览器请求先发给本地代理，因此目标接口不需要支持 CORS。
