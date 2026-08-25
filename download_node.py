import urllib.request
import zipfile
import os

url = "https://nodejs.org/dist/v22.2.0/node-v22.2.0-win-x64.zip"
zip_path = "node.zip"
extract_path = "."

print("Downloading Node.js from nodejs.org...")
urllib.request.urlretrieve(url, zip_path)
print("Extracting Node.js zip...")
with zipfile.ZipFile(zip_path, 'r') as zip_ref:
    zip_ref.extractall(extract_path)
if os.path.exists(".node"):
    # Clean up existing if any
    import shutil
    shutil.rmtree(".node")
print("Renaming folder to .node...")
os.rename("node-v22.2.0-win-x64", ".node")
print("Cleaning up zip...")
os.remove(zip_path)
print("Node.js portable setup complete!")
