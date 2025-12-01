source myvenv/bin/activate
pip3 install -r requirements.txt
python3 manage.py runserver
ngrok http 8000

###  Git Credential Helperでキャッシュ
git config --global credential.helper store

### renderで設定
    buildCommand: './build.sh'
    startCommand: 'daphne -b 0.0.0.0 -p 10000 cnc-pwa.asgi:application'
    .env内容を設定
    REDIS_URLを設定
    render.yamlの編集

### push
git add .
git commit -m "changed"
git push -u origin main

