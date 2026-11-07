"""
Supabase Storage S3 Client Module for Voice Campaign.
Provides high-performance, persistent object storage for telephony audio files
via Supabase's native S3-compatible API.
"""

import os
import logging
from typing import Optional, Tuple, Dict, Any
import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

DEFAULT_S3_ENDPOINT = "https://oyqcsfdzlbldrmykoosq.storage.supabase.co/storage/v1/s3"
DEFAULT_S3_ACCESS_KEY = "7f485ec1e04bbf701b0ad59f8f042acc"
DEFAULT_S3_SECRET_KEY = "95412e148c23e4f99e4a54bc8793abedee83ca5dddfae9b1d17c397ff09cfa67"
DEFAULT_S3_REGION = "ap-northeast-2"
DEFAULT_S3_BUCKET = "farmcalling-audio"
DEFAULT_PUBLIC_BASE = "https://oyqcsfdzlbldrmykoosq.supabase.co/storage/v1/object/public"

def get_s3_config() -> Dict[str, str]:
    """Resolves S3 settings from environment or defaults."""
    endpoint = os.environ.get("SUPABASE_S3_ENDPOINT") or os.environ.get("S3_ENDPOINT_URL") or DEFAULT_S3_ENDPOINT
    access_key = os.environ.get("SUPABASE_S3_ACCESS_KEY_ID") or os.environ.get("S3_ACCESS_KEY_ID") or os.environ.get("AWS_ACCESS_KEY_ID") or DEFAULT_S3_ACCESS_KEY
    secret_key = os.environ.get("SUPABASE_S3_SECRET_ACCESS_KEY") or os.environ.get("S3_SECRET_ACCESS_KEY") or os.environ.get("AWS_SECRET_ACCESS_KEY") or DEFAULT_S3_SECRET_KEY
    region = os.environ.get("SUPABASE_S3_REGION") or os.environ.get("S3_REGION_NAME") or os.environ.get("AWS_REGION") or DEFAULT_S3_REGION
    bucket = os.environ.get("SUPABASE_S3_BUCKET") or os.environ.get("S3_BUCKET_NAME") or DEFAULT_S3_BUCKET
    public_base = os.environ.get("SUPABASE_STORAGE_PUBLIC_URL") or os.environ.get("S3_PUBLIC_BASE_URL") or DEFAULT_PUBLIC_BASE

    return {
        "endpoint": endpoint.rstrip("/"),
        "access_key": access_key.strip(),
        "secret_key": secret_key.strip(),
        "region": region.strip(),
        "bucket": bucket.strip(),
        "public_base": public_base.rstrip("/")
    }

_s3_client = None

def get_s3_client():
    """Returns a singleton boto3 S3 client configured for Supabase Storage."""
    global _s3_client
    if _s3_client is not None:
        return _s3_client

    cfg = get_s3_config()
    try:
        _s3_client = boto3.client(
            "s3",
            endpoint_url=cfg["endpoint"],
            aws_access_key_id=cfg["access_key"],
            aws_secret_access_key=cfg["secret_key"],
            region_name=cfg["region"],
            config=Config(s3={"addressing_style": "path"})
        )
        return _s3_client
    except Exception as e:
        logger.error(f"Failed to initialize S3 client: {e}")
        return None

def is_s3_configured() -> bool:
    """Checks if S3 credentials and endpoint are present."""
    cfg = get_s3_config()
    return bool(cfg["endpoint"] and cfg["access_key"] and cfg["secret_key"] and cfg["bucket"])

def test_s3_connection() -> Tuple[bool, str, Dict[str, Any]]:
    """Tests S3 connection by listing buckets."""
    if not is_s3_configured():
        return False, "S3 storage credentials are not configured.", {}

    try:
        client = get_s3_client()
        if client is None:
            return False, "Could not initialize S3 client.", {}

        cfg = get_s3_config()
        resp = client.list_buckets()
        buckets = [b["Name"] for b in resp.get("Buckets", [])]
        bucket_found = cfg["bucket"] in buckets

        if not bucket_found:
            # Try to create bucket if missing
            try:
                client.create_bucket(Bucket=cfg["bucket"])
                bucket_found = True
            except Exception as ce:
                logger.warning(f"Could not auto-create bucket {cfg['bucket']}: {ce}")

        return True, f"Connected to Supabase S3 successfully. Bucket '{cfg['bucket']}' is active.", {
            "bucket": cfg["bucket"],
            "region": cfg["region"],
            "endpoint": cfg["endpoint"],
            "all_buckets": buckets
        }
    except Exception as e:
        logger.error(f"S3 connection test failed: {e}")
        return False, f"S3 connection error: {str(e)}", {}

def get_s3_public_url(s3_key: str, bucket_name: Optional[str] = None) -> str:
    """Returns the direct public CDN URL for an S3 object."""
    cfg = get_s3_config()
    b = bucket_name or cfg["bucket"]
    clean_key = s3_key.lstrip("/")
    return f"{cfg['public_base']}/{b}/{clean_key}"

def upload_audio_to_s3(
    filename: str,
    audio_bytes: bytes,
    mime_type: str = "audio/wav",
    bucket_name: Optional[str] = None
) -> Tuple[bool, str, str]:
    """
    Uploads audio bytes to Supabase Storage S3.
    Returns: (success: bool, s3_key: str, public_url: str)
    """
    if not audio_bytes:
        return False, "", ""

    cfg = get_s3_config()
    b = bucket_name or cfg["bucket"]
    client = get_s3_client()

    if client is None:
        logger.warning("S3 client unavailable. Falling back to local/DB storage.")
        return False, filename, ""

    try:
        clean_key = os.path.basename(filename)
        content_type = mime_type or ("audio/wav" if clean_key.endswith(".wav") else "audio/mpeg")

        client.put_object(
            Bucket=b,
            Key=clean_key,
            Body=audio_bytes,
            ContentType=content_type,
            CacheControl="public, max-age=31536000, immutable"
        )

        public_url = get_s3_public_url(clean_key, bucket_name=b)
        logger.info(f"Successfully uploaded {clean_key} ({len(audio_bytes)} bytes) to S3: {public_url}")
        return True, clean_key, public_url
    except Exception as e:
        logger.error(f"Failed to upload {filename} to S3 bucket {b}: {e}")
        return False, filename, ""

def get_audio_from_s3(s3_key: str, bucket_name: Optional[str] = None) -> Optional[bytes]:
    """Downloads audio bytes directly from Supabase Storage S3."""
    if not s3_key:
        return None

    cfg = get_s3_config()
    b = bucket_name or cfg["bucket"]
    client = get_s3_client()

    if client is None:
        return None

    try:
        clean_key = os.path.basename(s3_key)
        resp = client.get_object(Bucket=b, Key=clean_key)
        data = resp["Body"].read()
        return data
    except ClientError as ce:
        code = ce.response.get("Error", {}).get("Code", "")
        if code in ["404", "NoSuchKey"]:
            logger.warning(f"S3 object {s3_key} not found in bucket {b}")
        else:
            logger.warning(f"S3 get_object error for {s3_key}: {ce}")
        return None
    except Exception as e:
        logger.warning(f"Error reading S3 object {s3_key}: {e}")
        return None

def delete_audio_from_s3(s3_key: str, bucket_name: Optional[str] = None) -> bool:
    """Deletes an object from Supabase Storage S3."""
    if not s3_key:
        return False

    cfg = get_s3_config()
    b = bucket_name or cfg["bucket"]
    client = get_s3_client()

    if client is None:
        return False

    try:
        clean_key = os.path.basename(s3_key)
        client.delete_object(Bucket=b, Key=clean_key)
        logger.info(f"Deleted S3 object {clean_key} from bucket {b}")
        return True
    except Exception as e:
        logger.warning(f"Failed to delete S3 object {s3_key}: {e}")
        return False
