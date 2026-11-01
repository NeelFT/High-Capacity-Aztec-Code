export interface StoredPacket {
  session: number;
  frameId: number;
  packet: Uint8Array;
}

interface PacketRecord {
  key: string;
  session: number;
  frameId: number;
  packet: ArrayBuffer;
}

const DATABASE_NAME = 'hcac-receiver';
const DATABASE_VERSION = 1;
const PACKET_STORE = 'packets';

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this browser context.'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database.objectStoreNames.contains(PACKET_STORE)) return;
      const store = database.createObjectStore(PACKET_STORE, { keyPath: 'key' });
      store.createIndex('session', 'session', { unique: false });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open receiver packet storage.'));
    request.onblocked = () => reject(new Error('Receiver packet storage is blocked by another open app tab.'));
  });
  databasePromise.catch(() => { databasePromise = null; });
  return databasePromise;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Receiver packet storage transaction was aborted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Receiver packet storage transaction failed.'));
  });
}

export async function saveReceivedPacket(session: number, frameId: number, packet: Uint8Array): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(PACKET_STORE, 'readwrite');
  const copy = new Uint8Array(packet.byteLength);
  copy.set(packet);
  transaction.objectStore(PACKET_STORE).put({
    key: `${session}:${frameId}`,
    session,
    frameId,
    packet: copy.buffer,
  } satisfies PacketRecord);
  await transactionDone(transaction);
}

export async function loadReceivedPackets(session: number): Promise<StoredPacket[]> {
  const database = await openDatabase();
  const transaction = database.transaction(PACKET_STORE, 'readonly');
  const request = transaction.objectStore(PACKET_STORE).index('session').getAll(IDBKeyRange.only(session)) as IDBRequest<PacketRecord[]>;
  const packets = await new Promise<PacketRecord[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not read saved receiver packets.'));
  });
  await transactionDone(transaction);
  return packets
    .sort((a, b) => a.frameId - b.frameId)
    .map(({ session: packetSession, frameId, packet }) => ({
      session: packetSession,
      frameId,
      packet: new Uint8Array(packet),
    }));
}

export async function deleteReceivedPackets(session: number): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(PACKET_STORE, 'readwrite');
  const index = transaction.objectStore(PACKET_STORE).index('session');
  const request = index.openCursor(IDBKeyRange.only(session));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
  request.onerror = () => transaction.abort();
  await transactionDone(transaction);
}
