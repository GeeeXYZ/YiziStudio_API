import oss2
from oss2.exceptions import RequestError

auth = oss2.Auth('fake_key', 'fake_secret')
# If we pass bucket.region as endpoint:
endpoint = 'https://yizistudio-ai.oss-cn-shenzhen.aliyuncs.com'
bucket_name = 'yizistudio-ai'

bucket = oss2.Bucket(auth, endpoint, bucket_name)

try:
    bucket.put_object('test.txt', b'hello')
except Exception as e:
    import traceback
    traceback.print_exc()
    print("Caught:", type(e), e)
