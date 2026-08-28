# รันทุกขั้นตั้งแต่อุ่น cache จนได้โมเดลที่ตรวจแล้วลง data/ai/ ของเว็บ
#
# แยกเป็นสคริปต์เดียวเพราะขั้นตอนต่อกันเป็นสาย ถ้าขั้นไหนล้มก็ไม่ต้องรันขั้นถัดไป
# และขั้นแรก (โควตา Open-Meteo) อาจต้องรอเป็นสิบนาที ปล่อยรันยาวทีเดียวจบดีกว่า
#
#     powershell -ExecutionPolicy Bypass -File tools/runAll.ps1

$ErrorActionPreference = 'Continue'

$node = 'C:\Program Files\nodejs\node.exe'
$py = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($name, $block) {
    Write-Output ''
    Write-Output "===== $name ====="
    & $block
    if ($LASTEXITCODE -ne 0) {
        Write-Output "!!!! ล้มเหลวที่ขั้น: $name (exit $LASTEXITCODE)"
        exit 1
    }
}

# 1. อุ่น cache อากาศให้ครบก่อน — ขั้นนี้เท่านั้นที่ต้องรอโควตา
Step 'อุ่น cache สภาพอากาศ' { & $node tools/warmWeather.js }

# 2. รวมทุกแหล่งเป็น panel.csv (อากาศมาจาก cache แล้ว จึงไม่แตะเน็ตอีก)
Step 'สร้าง panel.csv' { & $node src/cli.js build }

# 3. เทรน — ขั้นที่กินเวลา CPU มากที่สุด
Step 'เทรนโมเดล' { & $py train/train.py --algo xgboost }

# 4. แปลงเป็น JSON ให้เบราว์เซอร์ + ส่งออกปฏิทินวันหยุด
Step 'แปลงโมเดลเป็น JSON' { & $py train/export_web.py }
Step 'ส่งออกปฏิทินวันหยุด' { & $node src/exportHolidays.js }

# จุดเสี่ยงจริงพร้อมพิกัด — ไม่ต้องใช้อากาศ จึงรันแยกได้แม้ panel.csv ยังไม่มี
Step 'ส่งออกจุดเสี่ยงจริง' { & $node tools/exportHotspots.js }

# 5. ด่านสุดท้าย — JS ต้องให้ผลเท่ากับ XGBoost ไม่งั้นถือว่าใช้ไม่ได้
Step 'ตรวจผลฝั่งเบราว์เซอร์' { & $node tools/verifyWebModel.js }
Step 'ตรวจการต่อระบบฝั่งแอป' { & $node tools/smokeForecast.js }

Write-Output ''
Write-Output '===== เสร็จทั้งหมด ====='
