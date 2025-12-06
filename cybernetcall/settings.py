"""
Django settings for cybernetcall project.
"""

from pathlib import Path
import os
import environ
import json
import base64
from dj_database_url import parse as dburl

# ----------------------------------------------------------------------
# Firebase Admin SDK 初期化に必要なライブラリ
import firebase_admin
from firebase_admin import credentials
# ----------------------------------------------------------------------


# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent

# ----------------------------------------------------------------------
# 環境変数の読み込みと設定
# ----------------------------------------------------------------------
env = environ.Env(
    # 型定義とローカル環境でのデフォルト値を指定
    DEBUG=(bool, False),
    SECRET_KEY=(str, 'django-insecure-vaj*zpu!9^3=8%=_n(*9z39dq29l!mbf49rz(jr62k744wvl7j'),
    DATABASE_URL=(str, "sqlite:///" + str(BASE_DIR / "db.sqlite3")),
    REDIS_URL=(str, "redis://localhost:6379"),
    FCM_SENDER_ID=(str, ""), # manifest.json で使用
    FCM_VAPID_KEY=(str, ""), # app.js で使用する VAPID 公開鍵
    # 秘密鍵JSONをBase64エンコードした文字列を格納
    FIREBASE_ADMIN_SDK_JSON_BASE64=(str, "") 
)
env.read_env(os.path.join(BASE_DIR, ".env"))


# Quick-start development settings - unsuitable for production
SECRET_KEY = env('SECRET_KEY')
DEBUG = env('DEBUG')
ALLOWED_HOSTS = ['cnc-pwa.onrender.com', '127.0.0.1', 'localhost']


# Application definition
INSTALLED_APPS = [
    'daphne',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'cnc',
    'signaling', 
    'channels', 
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'cnc.middleware.ServiceWorkerAllowedHeaderMiddleware', 
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'cybernetcall.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

ASGI_APPLICATION = 'cybernetcall.asgi.application'
WSGI_APPLICATION = 'cybernetcall.wsgi.application'


# ----------------------------------------------------------------------
# Channels and Redis Configuration
# ----------------------------------------------------------------------

redis_url = env('REDIS_URL')

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [redis_url],
            "symmetric_encryption_keys": [SECRET_KEY], 
        },
    },
}


# ----------------------------------------------------------------------
# Database Configuration
# ----------------------------------------------------------------------

# DATABASES の default は env.db('DATABASE_URL') で読み込まれます
DATABASES = {
    'default': env.db('DATABASE_URL')
}


# Password validation
AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]


# Internationalization
LANGUAGE_CODE = 'ja'
TIME_ZONE = 'Asia/Tokyo'
USE_I18N = True
USE_TZ = True


# Static files
STATIC_URL = '/static/'
STATICFILES_DIRS = [
    BASE_DIR / 'cnc/static',
]
STATIC_ROOT = str(BASE_DIR / "staticfiles")
STATICFILES_STORAGE = "whitenoise.storage.CompressedManifestStaticFilesStorage"
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'


# ----------------------------------------------------------------------
# Firebase and Notification Settings (FCM/PWA)
# ----------------------------------------------------------------------

FCM_SENDER_ID = env('FCM_SENDER_ID')
FCM_VAPID_KEY = env('FCM_VAPID_KEY') 
FIREBASE_ADMIN_SDK_JSON_BASE64 = env('FIREBASE_ADMIN_SDK_JSON_BASE64') 

# Firebase Admin SDK の初期化
# 秘密鍵が設定されていれば初期化を実行
if FIREBASE_ADMIN_SDK_JSON_BASE64:
    try:
        # Base64文字列をデコードし、JSONとしてロード
        json_string = base64.b64decode(FIREBASE_ADMIN_SDK_JSON_BASE64).decode('utf-8')
        service_account_info = json.loads(json_string)

        # 認証情報オブジェクトを作成
        cred = credentials.Certificate(service_account_info)
        
        # アプリケーションの初期化
        firebase_admin.initialize_app(cred)
        
        # 初期化成功のフラグ
        FIREBASE_INITIALIZED = True
        
    except Exception as e:
        print(f"Firebase Admin SDK 初期化失敗: {e}")
        FIREBASE_INITIALIZED = False
else:
    # 秘密鍵が設定されていない
    FIREBASE_INITIALIZED = False


# Superuser Configuration
SUPERUSER_NAME = env("SUPERUSER_NAME")
SUPERUSER_EMAIL = env("SUPERUSER_EMAIL")
SUPERUSER_PASSWORD = env("SUPERUSER_PASSWORD")