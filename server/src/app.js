import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  SESSION_COOKIE,
  activeAdminCount,
  createSession,
  deleteSession,
  findSessionUser,
  findUserForLogin,
  hashPassword,
  insertUser,
  listUsers,
  updatePassword,
  updateUserActive,
  userCount,
  verifyPassword,
} from './auth.js';
import {
  createExpenditure,
  createFeed,
  createPurchase,
  createRoom,
  createRoomAssignment,
  createSale,
  createTreatment,
  createWeight,
  deleteExpenditure,
  deleteFeed,
  deletePurchase,
  deleteRoom,
  deleteRoomAssignment,
  deleteSale,
  deleteTreatment,
  deleteWeight,
  getDashboard,
  listExpenditures,
  listFeeds,
  listInventory,
  listPurchases,
  listRoomAssignments,
  listRooms,
  listSales,
  listTreatments,
  listWeights,
  moveRoomAssignment,
  updateRoom,
  updateWeight,
} from './db.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      return [key, decodeURIComponent(value)];
    } catch {
      return [key, ''];
    }
  }).filter(([key]) => key));
}

function sessionToken(request) {
  return parseCookies(request.headers.cookie)[SESSION_COOKIE] || '';
}

function setSessionCookie(response, session) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(session.expiresAt).toUTCString()}${secure}`,
  );
}

function clearSessionCookie(response) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

function requireAuthentication(request, response, next) {
  const user = findSessionUser(sessionToken(request));
  if (!user) {
    response.status(401).json({ message: 'Authentication required.' });
    return;
  }
  request.user = user;
  next();
}

function requireAdmin(request, response, next) {
  if (request.user?.role !== 'admin') {
    response.status(403).json({ message: 'Administrator access is required.' });
    return;
  }
  next();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw httpError(400, 'A valid record ID is required.');
  }
  return id;
}

function requiredText(value, label, maxLength = 100) {
  if (typeof value !== 'string' || !value.trim()) {
    throw httpError(400, `${label} is required.`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw httpError(400, `${label} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function optionalText(value, label, maxLength = 500) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') {
    throw httpError(400, `${label} must be text.`);
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw httpError(400, `${label} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw httpError(400, `${label} must be a whole number greater than zero.`);
  }
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw httpError(400, `${label} must be a whole number of zero or greater.`);
  }
  return number;
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw httpError(400, `${label} must be greater than zero.`);
  }
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function measurementType(value) {
  if (value !== 'weekly' && value !== 'monthly') {
    throw httpError(400, 'Measurement type must be weekly or monthly.');
  }
  return value;
}

function feedSlot(value) {
  if (value !== 'morning' && value !== 'afternoon' && value !== 'evening') {
    throw httpError(400, 'Meal slot must be morning, afternoon, or evening.');
  }
  return value;
}

function isoTime(value, label) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw httpError(400, `${label} must be a valid 24-hour time.`);
  }
  return value;
}

function nonNegativeMoney(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw httpError(400, `${label} must be zero or greater.`);
  }
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function isoDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw httpError(400, `${label} must be a valid date.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw httpError(400, `${label} must be a valid date.`);
  }
  return value;
}

function optionalIsoDate(value, label) {
  if (value == null || value === '') return '';
  return isoDate(value, label);
}

function parsePurchase(body = {}) {
  return {
    purchaseDate: isoDate(body.purchaseDate, 'Purchase date'),
    supplier: requiredText(body.supplier, 'Supplier'),
    species: requiredText(body.species, 'Species', 60),
    breed: optionalText(body.breed, 'Breed', 60),
    quantity: positiveInteger(body.quantity, 'Quantity'),
    unitCost: nonNegativeMoney(body.unitCost, 'Unit cost'),
    transportCost: nonNegativeMoney(body.transportCost ?? 0, 'Transport cost'),
    notes: optionalText(body.notes, 'Notes'),
  };
}

function parseSale(body = {}) {
  return {
    saleDate: isoDate(body.saleDate, 'Sale date'),
    customer: requiredText(body.customer, 'Customer'),
    purchaseId: parseId(body.purchaseId),
    quantity: positiveInteger(body.quantity, 'Quantity'),
    unitPrice: nonNegativeMoney(body.unitPrice, 'Unit price'),
    notes: optionalText(body.notes, 'Notes'),
  };
}

function parseWeight(body = {}) {
  return {
    weightDate: isoDate(body.weightDate, 'Weight date'),
    purchaseId: parseId(body.purchaseId),
    animalTag: requiredText(body.animalTag, 'Animal ID / tag', 60),
    measurementType: measurementType(body.measurementType),
    weightKg: positiveNumber(body.weightKg, 'Weight'),
    notes: optionalText(body.notes, 'Notes'),
  };
}

function parseTreatment(body = {}) {
  const treatmentDate = isoDate(body.treatmentDate, 'Treatment date');
  const followUpDate = optionalIsoDate(body.followUpDate, 'Follow-up date');
  if (followUpDate && followUpDate < treatmentDate) {
    throw httpError(400, 'Follow-up date must be on or after treatment date.');
  }

  return {
    treatmentDate,
    purchaseId: parseId(body.purchaseId),
    animalTag: requiredText(body.animalTag, 'Animal ID / tag', 60),
    treatmentDescription: requiredText(body.treatmentDescription, 'Treatment description', 500),
    medicine: optionalText(body.medicine, 'Medicine', 100),
    dosage: optionalText(body.dosage, 'Dosage', 100),
    veterinarian: optionalText(body.veterinarian, 'Veterinarian', 100),
    treatmentCost: nonNegativeMoney(body.treatmentCost ?? 0, 'Treatment cost'),
    followUpDate,
    notes: optionalText(body.notes, 'Notes'),
  };
}

function parseFeed(body = {}) {
  return {
    feedDate: isoDate(body.feedDate, 'Feed date'),
    feedTime: isoTime(body.feedTime, 'Feed time'),
    purchaseId: parseId(body.purchaseId),
    slot: feedSlot(body.slot),
    basketCount: positiveInteger(body.basketCount, 'Basket count'),
    feedDescription: optionalText(body.feedDescription, 'Feed description', 500),
    notes: optionalText(body.notes, 'Notes'),
  };
}

function parseRoom(body = {}) {
  return {
    name: requiredText(body.name, 'Room name', 100),
    capacity: nonNegativeInteger(body.capacity ?? 0, 'Room capacity'),
    description: optionalText(body.description, 'Room description', 500),
  };
}

function parseRoomAssignment(body = {}) {
  return {
    roomId: parseId(body.roomId),
    purchaseId: parseId(body.purchaseId),
    animalTag: requiredText(body.animalTag, 'Animal ID / tag', 60),
    notes: optionalText(body.notes, 'Notes', 500),
  };
}

function parseExpenditure(body = {}) {
  return {
    expenditureDate: isoDate(body.expenditureDate, 'Expenditure date'),
    purpose: requiredText(body.purpose, 'Purpose', 100),
    paidTo: requiredText(body.paidTo, 'Paid to', 100),
    amount: positiveNumber(body.amount, 'Amount'),
    remarks: optionalText(body.remarks, 'Remarks', 500),
  };
}

function username(value) {
  const result = requiredText(value, 'Username', 60);
  if (!/^[A-Za-z0-9._-]{3,60}$/.test(result)) {
    throw httpError(400, 'Username must be 3-60 characters using letters, numbers, dot, underscore, or hyphen.');
  }
  return result;
}

function password(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) {
    throw httpError(400, 'Password must be between 10 and 128 characters.');
  }
  return value;
}

function userRole(value) {
  if (value !== 'admin' && value !== 'staff') {
    throw httpError(400, 'Role must be admin or staff.');
  }
  return value;
}

function parseUser(body = {}, defaultRole = 'staff') {
  return {
    username: username(body.username),
    displayName: requiredText(body.displayName, 'Display name', 100),
    password: password(body.password),
    role: userRole(body.role ?? defaultRole),
  };
}

app.get('/api/auth/status', (_request, response) => {
  response.json({ setupRequired: userCount() === 0 });
});

app.post('/api/auth/setup', async (request, response) => {
  if (userCount() !== 0) throw httpError(409, 'Initial administrator setup is already complete.');
  const input = parseUser({ ...request.body, role: 'admin' }, 'admin');
  const passwordHash = await hashPassword(input.password);
  const user = insertUser({ ...input, passwordHash, role: 'admin' });
  const session = createSession(user.id);
  setSessionCookie(response, session);
  response.status(201).json({ user });
});

app.post('/api/auth/login', async (request, response) => {
  const loginUsername = username(request.body?.username);
  const loginPassword = typeof request.body?.password === 'string' ? request.body.password : '';
  const userRecord = findUserForLogin(loginUsername);
  const validPassword = userRecord
    ? await verifyPassword(loginPassword, userRecord.passwordHash)
    : false;
  if (!userRecord || !userRecord.isActive || !validPassword) {
    throw httpError(401, 'Invalid username or password.');
  }
  const session = createSession(userRecord.id);
  setSessionCookie(response, session);
  response.json({
    user: {
      id: userRecord.id,
      username: userRecord.username,
      displayName: userRecord.displayName,
      role: userRecord.role,
      isActive: true,
      createdAt: userRecord.createdAt,
      updatedAt: userRecord.updatedAt,
    },
  });
});

app.post('/api/auth/logout', (request, response) => {
  deleteSession(sessionToken(request));
  clearSessionCookie(response);
  response.status(204).end();
});

app.get('/api/auth/me', requireAuthentication, (request, response) => {
  response.json({ user: request.user });
});

app.use('/api', requireAuthentication);

app.get('/api/users', requireAdmin, (_request, response) => {
  response.json(listUsers());
});

app.post('/api/users', requireAdmin, async (request, response) => {
  const input = parseUser(request.body);
  const passwordHash = await hashPassword(input.password);
  const user = insertUser({ ...input, passwordHash });
  response.status(201).json(user);
});

app.patch('/api/users/:id/active', requireAdmin, (request, response) => {
  const userId = parseId(request.params.id);
  if (typeof request.body?.isActive !== 'boolean') {
    throw httpError(400, 'Active status must be true or false.');
  }
  if (userId === request.user.id && !request.body.isActive) {
    throw httpError(409, 'You cannot deactivate your own account.');
  }
  const target = listUsers().find((user) => user.id === userId);
  if (!target) throw httpError(404, 'User not found.');
  if (target.role === 'admin' && target.isActive && !request.body.isActive && activeAdminCount() <= 1) {
    throw httpError(409, 'At least one active administrator is required.');
  }
  response.json(updateUserActive(userId, request.body.isActive));
});

app.patch('/api/users/:id/password', requireAdmin, async (request, response) => {
  const userId = parseId(request.params.id);
  const newPassword = password(request.body?.password);
  const target = listUsers().find((user) => user.id === userId);
  if (!target) throw httpError(404, 'User not found.');
  const passwordHash = await hashPassword(newPassword);
  const user = updatePassword(userId, passwordHash);
  response.json(user);
});

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' });
});

app.get('/api/dashboard', (_request, response) => {
  response.json(getDashboard());
});

app.get('/api/purchases', (_request, response) => {
  response.json(listPurchases());
});

app.post('/api/purchases', requireAdmin, (request, response) => {
  const purchase = createPurchase(parsePurchase(request.body));
  response.status(201).json(purchase);
});

app.delete('/api/purchases/:id', requireAdmin, (request, response) => {
  const result = deletePurchase(parseId(request.params.id));

  if (result.hasSales) {
    throw httpError(409, 'This purchase cannot be deleted because sales are linked to it.');
  }
  if (result.hasTreatments) {
    throw httpError(409, 'This purchase cannot be deleted because treatment history is linked to it.');
  }
  if (result.hasFeeds) {
    throw httpError(409, 'This purchase cannot be deleted because feed history is linked to it.');
  }
  if (result.hasRoomAssignments) {
    throw httpError(409, 'This purchase cannot be deleted while animals are assigned to rooms.');
  }
  if (!result.deleted) {
    throw httpError(404, 'Purchase not found.');
  }

  response.status(204).end();
});

app.get('/api/inventory', (_request, response) => {
  response.json(listInventory());
});

app.get('/api/sales', (_request, response) => {
  response.json(listSales());
});

app.post('/api/sales', requireAdmin, (request, response) => {
  const sale = createSale(parseSale(request.body));
  response.status(201).json(sale);
});

app.delete('/api/sales/:id', requireAdmin, (request, response) => {
  const deleted = deleteSale(parseId(request.params.id));
  if (!deleted) {
    throw httpError(404, 'Sale not found.');
  }
  response.status(204).end();
});

app.get('/api/weights', (_request, response) => {
  response.json(listWeights());
});

app.post('/api/weights', requireAdmin, (request, response) => {
  const weight = createWeight(parseWeight(request.body));
  response.status(201).json(weight);
});

app.patch('/api/weights/:id', requireAdmin, (request, response) => {
  const weight = updateWeight(
    parseId(request.params.id),
    parseWeight(request.body),
  );
  response.json(weight);
});

app.delete('/api/weights/:id', requireAdmin, (request, response) => {
  const deleted = deleteWeight(parseId(request.params.id));
  if (!deleted) {
    throw httpError(404, 'Weight entry not found.');
  }
  response.status(204).end();
});

app.get('/api/treatments', (_request, response) => {
  response.json(listTreatments());
});

app.post('/api/treatments', requireAdmin, (request, response) => {
  const treatment = createTreatment(parseTreatment(request.body));
  response.status(201).json(treatment);
});

app.delete('/api/treatments/:id', requireAdmin, (request, response) => {
  const deleted = deleteTreatment(parseId(request.params.id));
  if (!deleted) {
    throw httpError(404, 'Treatment record not found.');
  }
  response.status(204).end();
});

app.get('/api/feeds', (_request, response) => {
  response.json(listFeeds());
});

app.post('/api/feeds', requireAdmin, (request, response) => {
  const feed = createFeed(parseFeed(request.body));
  response.status(201).json(feed);
});

app.delete('/api/feeds/:id', requireAdmin, (request, response) => {
  const deleted = deleteFeed(parseId(request.params.id));
  if (!deleted) {
    throw httpError(404, 'Feed entry not found.');
  }
  response.status(204).end();
});

app.get('/api/rooms', (_request, response) => {
  response.json(listRooms());
});

app.post('/api/rooms', requireAdmin, (request, response) => {
  const room = createRoom(parseRoom(request.body));
  response.status(201).json(room);
});

app.patch('/api/rooms/:id', requireAdmin, (request, response) => {
  const room = updateRoom(
    parseId(request.params.id),
    parseRoom(request.body),
  );
  response.json(room);
});

app.delete('/api/rooms/:id', requireAdmin, (request, response) => {
  const result = deleteRoom(parseId(request.params.id));
  if (result.hasAssignments) {
    throw httpError(409, 'This room cannot be deleted while animals are assigned to it.');
  }
  if (!result.deleted) {
    throw httpError(404, 'Room not found.');
  }
  response.status(204).end();
});

app.get('/api/room-assignments', (_request, response) => {
  response.json(listRoomAssignments());
});

app.post('/api/room-assignments', requireAdmin, (request, response) => {
  const assignment = createRoomAssignment(parseRoomAssignment(request.body));
  response.status(201).json(assignment);
});

app.patch('/api/room-assignments/:id', requireAdmin, (request, response) => {
  const assignment = moveRoomAssignment(
    parseId(request.params.id),
    parseId(request.body?.roomId),
  );
  response.json(assignment);
});

app.delete('/api/room-assignments/:id', requireAdmin, (request, response) => {
  const deleted = deleteRoomAssignment(parseId(request.params.id));
  if (!deleted) {
    throw httpError(404, 'Room assignment not found.');
  }
  response.status(204).end();
});

app.get('/api/expenditures', (_request, response) => {
  response.json(listExpenditures());
});

app.post('/api/expenditures', requireAdmin, (request, response) => {
  const expenditure = createExpenditure(parseExpenditure(request.body));
  response.status(201).json(expenditure);
});

app.delete('/api/expenditures/:id', requireAdmin, (request, response) => {
  const deleted = deleteExpenditure(parseId(request.params.id));
  if (!deleted) {
    throw httpError(404, 'Expenditure not found.');
  }
  response.status(204).end();
});

app.use('/api', (_request, response) => {
  response.status(404).json({ message: 'API route not found.' });
});

const clientDistPath = fileURLToPath(new URL('../../client/dist/', import.meta.url));
if (existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.use((request, response, next) => {
    if (request.method === 'GET' && request.accepts('html')) {
      response.sendFile('index.html', { root: clientDistPath });
      return;
    }
    next();
  });
}

app.use((error, _request, response, _next) => {
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error(error);
  response.status(status).json({
    message: status >= 500 ? 'An unexpected server error occurred.' : error.message,
  });
});
