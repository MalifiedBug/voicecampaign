import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Endpoint = process.env.SUPABASE_S3_ENDPOINT || 'https://oyqcsfdzlbldrmykoosq.storage.supabase.co/storage/v1/s3';
const s3Region = process.env.SUPABASE_S3_REGION || 'ap-northeast-2';
const s3AccessKey = process.env.SUPABASE_S3_ACCESS_KEY_ID || '7f485ec1e04bbf701b0ad59f8f042acc';
const s3SecretKey = process.env.SUPABASE_S3_SECRET_ACCESS_KEY || '95412e148c23e4f99e4a54bc8793abedee83ca5dddfae9b1d17c397ff09cfa67';
const s3Bucket = process.env.SUPABASE_S3_BUCKET || 'farmcalling-audio';
const publicBaseUrl = process.env.SUPABASE_STORAGE_PUBLIC_URL || 'https://oyqcsfdzlbldrmykoosq.supabase.co/storage/v1/object/public';

export const s3Client = new S3Client({
  region: s3Region,
  endpoint: s3Endpoint,
  credentials: {
    accessKeyId: s3AccessKey,
    secretAccessKey: s3SecretKey,
  },
  forcePathStyle: true,
});

export async function createPresignedUploadUrl(filename: string, contentType: string = 'audio/wav') {
  const cleanName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${Date.now()}_${cleanName}`;

  const command = new PutObjectCommand({
    Bucket: s3Bucket,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  const publicUrl = `${publicBaseUrl.replace(/\/$/, '')}/${s3Bucket}/${key}`;

  return {
    uploadUrl,
    publicUrl,
    key,
    bucket: s3Bucket,
  };
}

export async function deleteS3Object(key: string) {
  try {
    const command = new DeleteObjectCommand({
      Bucket: s3Bucket,
      Key: key,
    });
    await s3Client.send(command);
  } catch (err) {
    console.error('Error deleting S3 object:', err);
  }
}
