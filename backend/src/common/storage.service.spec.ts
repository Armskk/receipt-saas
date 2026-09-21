import { StorageService } from './storage.service';

// StorageService -> `minio` pulls in an ESM-only dependency jest can't parse,
// and these tests don't need a real MinIO: stub the client and drive the
// bucket-creation race by hand.
const bucketExists = jest.fn();
const makeBucket = jest.fn();
jest.mock('minio', () => ({
  Client: class {
    bucketExists = bucketExists;
    makeBucket = makeBucket;
  },
}));

function s3Error(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe('StorageService.onModuleInit', () => {
  beforeEach(() => {
    bucketExists.mockReset();
    makeBucket.mockReset();
  });

  it('creates the bucket when it does not exist', async () => {
    bucketExists.mockResolvedValue(false);
    makeBucket.mockResolvedValue(undefined);

    await new StorageService().onModuleInit();

    expect(makeBucket).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the bucket already exists', async () => {
    bucketExists.mockResolvedValue(true);

    await new StorageService().onModuleInit();

    expect(makeBucket).not.toHaveBeenCalled();
  });

  it('treats BucketAlreadyOwnedByYou as success (API and worker starting together)', async () => {
    bucketExists.mockResolvedValue(false);
    makeBucket.mockRejectedValue(s3Error('BucketAlreadyOwnedByYou'));

    await expect(new StorageService().onModuleInit()).resolves.toBeUndefined();
  });

  it('still fails on other bucket-creation errors', async () => {
    bucketExists.mockResolvedValue(false);
    makeBucket.mockRejectedValue(s3Error('AccessDenied'));

    await expect(new StorageService().onModuleInit()).rejects.toThrow('AccessDenied');
  });

  it('does not swallow BucketAlreadyExists (bucket owned by someone else)', async () => {
    bucketExists.mockResolvedValue(false);
    makeBucket.mockRejectedValue(s3Error('BucketAlreadyExists'));

    await expect(new StorageService().onModuleInit()).rejects.toThrow('BucketAlreadyExists');
  });
});
