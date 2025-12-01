source myvenv/bin/activate
pip3 install -r requirements.txt
python3 manage.py runserver
ngrok http 8000

###  Git Credential Helperでキャッシュ
git config --global credential.helper store

### push
git add .
git commit -m "changed"
git push -u origin main

