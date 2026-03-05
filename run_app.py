import time
import webbrowser
import threading
from dotenv import load_dotenv

def start_server():
    import uvicorn
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, reload=False)

if __name__ == "__main__":
    load_dotenv()  # đọc .env ở cùng thư mục
    t = threading.Thread(target=start_server, daemon=True)
    t.start()

    time.sleep(1.2)
    webbrowser.open("http://127.0.0.1:8000/")
    t.join()