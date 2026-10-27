$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = [Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
  function AwaitResult($operation, $resultType) {
    $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.Wait()
    $task.Result
  }
  $inputDoc = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $language = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Where-Object { $_.LanguageTag -match '^zh-Hans' } | Select-Object -First 1
  if (-not $language) { $language = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Select-Object -First 1 }
  if (-not $language) { throw 'No OCR language' }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  $file = AwaitResult ([Windows.Storage.StorageFile]::GetFileFromPathAsync($inputDoc.path)) ([Windows.Storage.StorageFile])
  $stream = AwaitResult ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $decoder = AwaitResult ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = AwaitResult ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = AwaitResult ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @($result.Lines | ForEach-Object {
    $left = [double]::PositiveInfinity; $top = [double]::PositiveInfinity; $right=0.0; $bottom=0.0
    foreach ($word in $_.Words) { $r=$word.BoundingRect; $left=[Math]::Min($left,$r.X);$top=[Math]::Min($top,$r.Y);$right=[Math]::Max($right,$r.X+$r.Width);$bottom=[Math]::Max($bottom,$r.Y+$r.Height) }
    @{text=$_.Text;region=@(($left/$bitmap.PixelWidth),($top/$bitmap.PixelHeight),(($right-$left)/$bitmap.PixelWidth),(($bottom-$top)/$bitmap.PixelHeight))}
  })
  @{ok=$true;language=$language.LanguageTag;lines=$lines} | ConvertTo-Json -Depth 8 -Compress
  $bitmap.Dispose();$stream.Dispose()
} catch {
  [Console]::Out.Write('{"ok":false,"lines":[]}')
  exit 1
}
