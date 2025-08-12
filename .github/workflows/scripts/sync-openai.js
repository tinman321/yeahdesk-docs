import fs from 'fs';
import axios from 'axios';
import FormData from 'form-data';

const REQUIRED = [
  'yeahdesk-docs_support.md',
  'yeahdesk-docs_product.md',
  'yeahdesk-docs_marketing.md',
];

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID   = process.env.OPENAI_ASSISTANT_ID;
let   VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID || '';

if (!OPENAI_API_KEY || !ASSISTANT_ID) {
  console.error('OPENAI_API_KEY и OPENAI_ASSISTANT_ID обязательны');
  process.exit(1);
}
for (const f of REQUIRED) {
  if (!fs.existsSync(f)) {
    console.error(`Файл отсутствует: ${f}`);
    process.exit(1);
  }
}

const api = axios.create({
  baseURL: 'https://api.openai.com/v1',
  headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
});

async function createVectorStore(name = `yeahdesk-knowledge-${Date.now()}`) {
  const { data } = await api.post('/vector_stores', { name });
  return data.id;
}

async function attachVectorStoreToAssistant(assistantId, vectorStoreId) {
  const payload = { tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } } };
  await api.post(`/assistants/${assistantId}`, payload);
}

async function listVectorStoreFiles(vectorStoreId) {
  const files = [];
  let cursor = null;
  do {
    const { data } = await api.get(`/vector_stores/${vectorStoreId}/files`, {
      params: { limit: 100, after: cursor || undefined }
    });
    files.push(...(data.data || []));
    cursor = data.has_more ? data.last_id : null;
  } while (cursor);
  return files; // элементы вида { id: 'file_...', ... }
}

async function getFileMeta(fileId) {
  const { data } = await api.get(`/files/${fileId}`);
  return data; // содержит filename
}

async function deleteFromVectorStore(vectorStoreId, fileId) {
  await api.delete(`/vector_stores/${vectorStoreId}/files/${fileId}`);
}

async function deleteAccountFile(fileId) {
  await api.delete(`/files/${fileId}`);
}

async function uploadFile(filepath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filepath));
  form.append('purpose', 'assistants');
  const { data } = await api.post('/files', form, { headers: form.getHeaders() });
  return data.id;
}

async function addFilesToVectorStore(vectorStoreId, fileIds) {
  await api.post(`/vector_stores/${vectorStoreId}/files`, { file_ids: fileIds });
}

(async () => {
  try {
    if (!VECTOR_STORE_ID) {
      VECTOR_STORE_ID = await createVectorStore();
      await attachVectorStoreToAssistant(ASSISTANT_ID, VECTOR_STORE_ID);
      console.log(`Создан и привязан Vector Store: ${VECTOR_STORE_ID}`);
    }

    // Дедупликация: вычистить прежние версии по имени файла
    const vsFiles = await listVectorStoreFiles(VECTOR_STORE_ID);
    const targetNames = new Set(REQUIRED);

    // Собираем file_id по совпадению filename
    const toRemove = [];
    for (const f of vsFiles) {
      try {
        const meta = await getFileMeta(f.id);
        if (meta?.filename && targetNames.has(meta.filename)) {
          toRemove.push(f.id);
        }
      } catch (e) {
        // пропускаем сбои получения метаданных
      }
    }

    // Удаляем из Vector Store и аккаунта
    for (const id of toRemove) {
      try { await deleteFromVectorStore(VECTOR_STORE_ID, id); } catch {}
      try { await deleteAccountFile(id); } catch {}
      console.log(`Удалена старая версия: ${id}`);
    }

    // Полная перезаливка 3 файлов
    const uploadedIds = [];
    for (const fp of REQUIRED) {
      const id = await uploadFile(fp);
      uploadedIds.push(id);
      console.log(`Загружен: ${fp} -> ${id}`);
    }

    await addFilesToVectorStore(VECTOR_STORE_ID, uploadedIds);
    console.log(`Файлы привязаны к Vector Store: ${VECTOR_STORE_ID}`);

  } catch (e) {
    console.error('Ошибка синка:', e.response?.data || e.message);
    process.exit(1);
  }
})();
