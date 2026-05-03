from pymongo import MongoClient
from dotenv import load_dotenv
import os

load_dotenv()

_client = None


def get_db():
    global _client
    if _client is None:
        _client = MongoClient(os.environ["MONGODB_URI"])
    return _client["Tastemaker"]
