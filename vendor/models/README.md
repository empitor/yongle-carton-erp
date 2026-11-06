# 本地语音模型

语音输入是可选功能，模型文件较大，不进 Git，也不随安装包提供。没有模型时其他功能不受影响。

需要这两个文件，放在 `vendor/models/sensevoice/`，文件名不要改：

- `model.int8.onnx`
- `tokens.txt`

下载 [sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2)（约 1 GB）后解压取出，或到 [Hugging Face](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/main) 只下载这两个文件。模型的使用条款以上游项目为准。
