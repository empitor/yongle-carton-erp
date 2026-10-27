# 本地语音资源（不进入Git）

现有SenseVoice模型与VAD、tokens资源保留在本机`vendor/models/sensevoice/`，不随私人仓库上传，未改名或删除。

在另一台电脑恢复语音功能时，从自己的离线备份复制完整`sensevoice`目录到这里，保持`model.int8.onnx`、`silero_vad.onnx`、`tokens.txt`原名。未复制资源时，ERP和AI文字聊天仍可用，语音会明确提示资源缺失。模型来自第三方，复制与分发应遵守其许可。
