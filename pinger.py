import urllib.request
import threading

url = "http://localhost:5001/pulse-49ce6/us-central1/updateUsers"
# url = "https://us-central1-pulse-49ce6.cloudfunctions.net/updateUsers"


def run_check():
    threading.Timer(2.0, run_check).start()
    print("HTTP Request sent.")
    urllib.request.urlopen(url).read()


if __name__ == "__main__":
    run_check()
