import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const defaultDatabasePath = fileURLToPath(
  new URL('../data/livestock.db', import.meta.url),
);
const databasePath = process.env.DATABASE_PATH || defaultDatabasePath;

mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_date TEXT NOT NULL,
    supplier TEXT NOT NULL,
    species TEXT NOT NULL,
    breed TEXT NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_cost REAL NOT NULL CHECK (unit_cost >= 0),
    transport_cost REAL NOT NULL DEFAULT 0 CHECK (transport_cost >= 0),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_date TEXT NOT NULL,
    customer TEXT NOT NULL,
    purchase_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price REAL NOT NULL CHECK (unit_price >= 0),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS weights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    weight_date TEXT NOT NULL,
    purchase_id INTEGER NOT NULL,
    animal_tag TEXT NOT NULL DEFAULT '',
    measurement_type TEXT NOT NULL DEFAULT 'weekly'
      CHECK (measurement_type IN ('weekly', 'monthly')),
    weight_kg REAL NOT NULL CHECK (weight_kg > 0),
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS treatments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    treatment_date TEXT NOT NULL,
    purchase_id INTEGER NOT NULL,
    animal_tag TEXT NOT NULL,
    treatment_description TEXT NOT NULL,
    medicine TEXT NOT NULL DEFAULT '',
    dosage TEXT NOT NULL DEFAULT '',
    veterinarian TEXT NOT NULL DEFAULT '',
    treatment_cost REAL NOT NULL DEFAULT 0 CHECK (treatment_cost >= 0),
    follow_up_date TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_date TEXT NOT NULL,
    feed_time TEXT NOT NULL,
    purchase_id INTEGER NOT NULL,
    slot TEXT NOT NULL CHECK (slot IN ('morning', 'afternoon', 'evening')),
    basket_count INTEGER NOT NULL CHECK (basket_count > 0),
    feed_description TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (purchase_id, feed_date, slot),
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    capacity INTEGER NOT NULL DEFAULT 0 CHECK (capacity >= 0),
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS room_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    purchase_id INTEGER NOT NULL,
    animal_tag TEXT NOT NULL COLLATE NOCASE UNIQUE,
    assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE RESTRICT,
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS expenditures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    expenditure_date TEXT NOT NULL,
    purpose TEXT NOT NULL,
    paid_to TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    remarks TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sales_purchase_id ON sales(purchase_id);
  CREATE INDEX IF NOT EXISTS idx_weights_purchase_id ON weights(purchase_id);
  CREATE INDEX IF NOT EXISTS idx_weights_date ON weights(weight_date);
  CREATE INDEX IF NOT EXISTS idx_treatments_purchase_id ON treatments(purchase_id);
  CREATE INDEX IF NOT EXISTS idx_treatments_date ON treatments(treatment_date);
  CREATE INDEX IF NOT EXISTS idx_treatments_animal_date ON treatments(animal_tag COLLATE NOCASE, treatment_date);
  CREATE INDEX IF NOT EXISTS idx_feeds_purchase_id ON feeds(purchase_id);
  CREATE INDEX IF NOT EXISTS idx_feeds_date_slot ON feeds(feed_date, slot);
  CREATE INDEX IF NOT EXISTS idx_room_assignments_room_id ON room_assignments(room_id);
  CREATE INDEX IF NOT EXISTS idx_room_assignments_purchase_id ON room_assignments(purchase_id);
  CREATE INDEX IF NOT EXISTS idx_expenditures_date ON expenditures(expenditure_date);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date);
  CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);
`);

const weightColumns = db.pragma('table_info(weights)');
if (!weightColumns.some((column) => column.name === 'measurement_type')) {
  db.exec(`
    ALTER TABLE weights
    ADD COLUMN measurement_type TEXT NOT NULL DEFAULT 'weekly'
      CHECK (measurement_type IN ('weekly', 'monthly'))
  `);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_weights_animal_period
  ON weights(animal_tag, measurement_type, weight_date);
`);

const purchaseSelect = `
  SELECT
    p.id,
    p.purchase_date AS purchaseDate,
    p.supplier,
    p.species,
    p.breed,
    p.quantity,
    p.unit_cost AS unitCost,
    p.transport_cost AS transportCost,
    p.notes,
    p.created_at AS createdAt,
    COALESCE(SUM(s.quantity), 0) AS soldQuantity,
    p.quantity - COALESCE(SUM(s.quantity), 0) AS availableQuantity,
    p.quantity * p.unit_cost + p.transport_cost AS totalCost,
    p.unit_cost + (p.transport_cost / p.quantity) AS landedUnitCost
  FROM purchases p
  LEFT JOIN sales s ON s.purchase_id = p.id
`;

const getPurchaseStatement = db.prepare(`
  ${purchaseSelect}
  WHERE p.id = ?
  GROUP BY p.id
`);

const weightSelect = `
  SELECT
    w.id,
    w.weight_date AS weightDate,
    w.purchase_id AS purchaseId,
    w.animal_tag AS animalTag,
    w.measurement_type AS measurementType,
    w.weight_kg AS weightKg,
    w.notes,
    w.created_at AS createdAt,
    p.species,
    p.breed,
    p.supplier
  FROM weights w
  JOIN purchases p ON p.id = w.purchase_id
`;

const treatmentSelect = `
  SELECT
    t.id,
    t.treatment_date AS treatmentDate,
    t.purchase_id AS purchaseId,
    t.animal_tag AS animalTag,
    t.treatment_description AS treatmentDescription,
    t.medicine,
    t.dosage,
    t.veterinarian,
    t.treatment_cost AS treatmentCost,
    t.follow_up_date AS followUpDate,
    t.notes,
    t.created_at AS createdAt,
    p.species,
    p.breed,
    p.supplier
  FROM treatments t
  JOIN purchases p ON p.id = t.purchase_id
`;

const feedSelect = `
  SELECT
    f.id,
    f.feed_date AS feedDate,
    f.feed_time AS feedTime,
    f.purchase_id AS purchaseId,
    f.slot,
    f.basket_count AS basketCount,
    f.feed_description AS feedDescription,
    f.notes,
    f.created_at AS createdAt,
    p.species,
    p.breed,
    p.supplier
  FROM feeds f
  JOIN purchases p ON p.id = f.purchase_id
`;

const roomAssignmentSelect = `
  SELECT
    ra.id,
    ra.room_id AS roomId,
    r.name AS roomName,
    r.capacity AS roomCapacity,
    ra.purchase_id AS purchaseId,
    ra.animal_tag AS animalTag,
    ra.assigned_at AS assignedAt,
    ra.updated_at AS updatedAt,
    ra.notes,
    p.species,
    p.breed,
    p.supplier
  FROM room_assignments ra
  JOIN rooms r ON r.id = ra.room_id
  JOIN purchases p ON p.id = ra.purchase_id
`;

function getAnimalPurchaseId(animalTag, excludedWeightId = null) {
  return db.prepare(`
    SELECT purchase_id AS purchaseId
    FROM (
      SELECT purchase_id, animal_tag FROM weights
      WHERE @excludedWeightId IS NULL OR id != @excludedWeightId
      UNION ALL
      SELECT purchase_id, animal_tag FROM treatments
      UNION ALL
      SELECT purchase_id, animal_tag FROM room_assignments
    )
    WHERE animal_tag = @animalTag COLLATE NOCASE
    LIMIT 1
  `).get({ animalTag, excludedWeightId })?.purchaseId ?? null;
}

export function getDashboard() {
  return db.prepare(`
    WITH batch_totals AS (
      SELECT
        p.id,
        p.quantity,
        p.unit_cost,
        p.transport_cost,
        COALESCE(SUM(s.quantity), 0) AS sold_quantity
      FROM purchases p
      LEFT JOIN sales s ON s.purchase_id = p.id
      GROUP BY p.id
    )
    SELECT
      COALESCE((SELECT SUM(quantity) FROM purchases), 0) AS totalPurchased,
      COALESCE((SELECT SUM(quantity * unit_cost + transport_cost) FROM purchases), 0) AS purchaseInvestment,
      COALESCE((SELECT SUM(quantity) FROM sales), 0) AS totalSold,
      COALESCE((SELECT SUM(quantity * unit_price) FROM sales), 0) AS salesRevenue,
      COALESCE((SELECT SUM(quantity - sold_quantity) FROM batch_totals), 0) AS currentStock,
      COALESCE((
        SELECT SUM((quantity - sold_quantity) * (unit_cost + transport_cost / quantity))
        FROM batch_totals
      ), 0) AS inventoryValue,
      COALESCE((
        SELECT SUM(s.quantity * (s.unit_price - (p.unit_cost + p.transport_cost / p.quantity)))
        FROM sales s
        JOIN purchases p ON p.id = s.purchase_id
      ), 0) AS realizedProfit
  `).get();
}

export function listPurchases() {
  return db.prepare(`
    ${purchaseSelect}
    GROUP BY p.id
    ORDER BY p.purchase_date DESC, p.id DESC
  `).all();
}

export function getPurchase(id) {
  return getPurchaseStatement.get(id);
}

export function createPurchase(purchase) {
  const result = db.prepare(`
    INSERT INTO purchases (
      purchase_date, supplier, species, breed, quantity,
      unit_cost, transport_cost, notes
    ) VALUES (
      @purchaseDate, @supplier, @species, @breed, @quantity,
      @unitCost, @transportCost, @notes
    )
  `).run(purchase);

  return getPurchase(result.lastInsertRowid);
}

export function deletePurchase(id) {
  const linkedRecords = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM sales WHERE purchase_id = ?) AS saleCount,
      (SELECT COUNT(*) FROM treatments WHERE purchase_id = ?) AS treatmentCount,
      (SELECT COUNT(*) FROM feeds WHERE purchase_id = ?) AS feedCount,
      (SELECT COUNT(*) FROM room_assignments WHERE purchase_id = ?) AS roomAssignmentCount
  `).get(id, id, id, id);

  if (linkedRecords.saleCount > 0) {
    return { deleted: false, hasSales: true, hasTreatments: false, hasFeeds: false, hasRoomAssignments: false };
  }
  if (linkedRecords.treatmentCount > 0) {
    return { deleted: false, hasSales: false, hasTreatments: true, hasFeeds: false, hasRoomAssignments: false };
  }
  if (linkedRecords.feedCount > 0) {
    return { deleted: false, hasSales: false, hasTreatments: false, hasFeeds: true, hasRoomAssignments: false };
  }
  if (linkedRecords.roomAssignmentCount > 0) {
    return { deleted: false, hasSales: false, hasTreatments: false, hasFeeds: false, hasRoomAssignments: true };
  }

  const result = db.prepare('DELETE FROM purchases WHERE id = ?').run(id);
  return { deleted: result.changes > 0, hasSales: false, hasTreatments: false, hasFeeds: false, hasRoomAssignments: false };
}

export function listInventory() {
  return db.prepare(`
    ${purchaseSelect}
    GROUP BY p.id
    HAVING p.quantity - COALESCE(SUM(s.quantity), 0) > 0
    ORDER BY p.purchase_date ASC, p.id ASC
  `).all();
}

export function listSales() {
  return db.prepare(`
    SELECT
      s.id,
      s.sale_date AS saleDate,
      s.customer,
      s.purchase_id AS purchaseId,
      s.quantity,
      s.unit_price AS unitPrice,
      s.notes,
      s.created_at AS createdAt,
      p.species,
      p.breed,
      p.supplier,
      s.quantity * s.unit_price AS revenue,
      s.quantity * (p.unit_cost + p.transport_cost / p.quantity) AS cost,
      s.quantity * (s.unit_price - (p.unit_cost + p.transport_cost / p.quantity)) AS profit
    FROM sales s
    JOIN purchases p ON p.id = s.purchase_id
    ORDER BY s.sale_date DESC, s.id DESC
  `).all();
}

const insertSale = db.transaction((sale) => {
  const batch = getPurchase(sale.purchaseId);

  if (!batch) {
    const error = new Error('The selected purchase batch does not exist.');
    error.status = 404;
    throw error;
  }

  if (sale.quantity > batch.availableQuantity) {
    const error = new Error(
      `Only ${batch.availableQuantity} animal${batch.availableQuantity === 1 ? '' : 's'} remain in this batch.`,
    );
    error.status = 409;
    throw error;
  }

  const result = db.prepare(`
    INSERT INTO sales (
      sale_date, customer, purchase_id, quantity, unit_price, notes
    ) VALUES (
      @saleDate, @customer, @purchaseId, @quantity, @unitPrice, @notes
    )
  `).run(sale);

  return db.prepare(`
    SELECT
      s.id,
      s.sale_date AS saleDate,
      s.customer,
      s.purchase_id AS purchaseId,
      s.quantity,
      s.unit_price AS unitPrice,
      s.notes,
      p.species,
      p.breed,
      s.quantity * s.unit_price AS revenue,
      s.quantity * (p.unit_cost + p.transport_cost / p.quantity) AS cost,
      s.quantity * (s.unit_price - (p.unit_cost + p.transport_cost / p.quantity)) AS profit
    FROM sales s
    JOIN purchases p ON p.id = s.purchase_id
    WHERE s.id = ?
  `).get(result.lastInsertRowid);
});

export function createSale(sale) {
  return insertSale(sale);
}

export function deleteSale(id) {
  const result = db.prepare('DELETE FROM sales WHERE id = ?').run(id);
  return result.changes > 0;
}

export function listWeights() {
  return db.prepare(`
    ${weightSelect}
    ORDER BY w.weight_date DESC, w.id DESC
  `).all();
}

export function createWeight(weight) {
  const batch = getPurchase(weight.purchaseId);
  if (!batch) {
    const error = new Error('The selected purchase batch does not exist.');
    error.status = 404;
    throw error;
  }
  if (batch.availableQuantity <= 0) {
    const error = new Error('The selected purchase batch has no animals remaining in stock.');
    error.status = 409;
    throw error;
  }

  const existingAnimalPurchaseId = getAnimalPurchaseId(weight.animalTag);

  if (existingAnimalPurchaseId && existingAnimalPurchaseId !== weight.purchaseId) {
    const error = new Error(
      `Animal ${weight.animalTag} is already linked to purchase batch #${existingAnimalPurchaseId}.`,
    );
    error.status = 409;
    throw error;
  }

  const result = db.prepare(`
    INSERT INTO weights (
      weight_date, purchase_id, animal_tag, measurement_type, weight_kg, notes
    ) VALUES (
      @weightDate, @purchaseId, @animalTag, @measurementType, @weightKg, @notes
    )
  `).run(weight);

  return db.prepare(`
    ${weightSelect}
    WHERE w.id = ?
  `).get(result.lastInsertRowid);
}

const updateWeightTransaction = db.transaction((id, weight) => {
  const current = db.prepare(`
    ${weightSelect}
    WHERE w.id = ?
  `).get(id);
  if (!current) {
    const error = new Error('Weight entry not found.');
    error.status = 404;
    throw error;
  }

  const batch = getPurchase(weight.purchaseId);
  if (!batch) {
    const error = new Error('The selected purchase batch does not exist.');
    error.status = 404;
    throw error;
  }
  if (weight.purchaseId !== current.purchaseId && batch.availableQuantity <= 0) {
    const error = new Error('The selected purchase batch has no animals remaining in stock.');
    error.status = 409;
    throw error;
  }

  const existingAnimalPurchaseId = getAnimalPurchaseId(weight.animalTag, id);
  if (existingAnimalPurchaseId && existingAnimalPurchaseId !== weight.purchaseId) {
    const error = new Error(
      `Animal ${weight.animalTag} is already linked to purchase batch #${existingAnimalPurchaseId}.`,
    );
    error.status = 409;
    throw error;
  }

  db.prepare(`
    UPDATE weights
    SET
      weight_date = @weightDate,
      purchase_id = @purchaseId,
      animal_tag = @animalTag,
      measurement_type = @measurementType,
      weight_kg = @weightKg,
      notes = @notes
    WHERE id = @id
  `).run({ id, ...weight });

  return db.prepare(`
    ${weightSelect}
    WHERE w.id = ?
  `).get(id);
});

export function updateWeight(id, weight) {
  return updateWeightTransaction(id, weight);
}

export function deleteWeight(id) {
  const result = db.prepare('DELETE FROM weights WHERE id = ?').run(id);
  return result.changes > 0;
}

export function listTreatments() {
  return db.prepare(`
    ${treatmentSelect}
    ORDER BY t.treatment_date DESC, t.id DESC
  `).all();
}

const insertTreatment = db.transaction((treatment) => {
  const batch = getPurchase(treatment.purchaseId);
  if (!batch) {
    const error = new Error('The selected purchase batch does not exist.');
    error.status = 404;
    throw error;
  }
  if (batch.availableQuantity <= 0) {
    const error = new Error('The selected purchase batch has no animals remaining in stock.');
    error.status = 409;
    throw error;
  }

  const existingAnimalPurchaseId = getAnimalPurchaseId(treatment.animalTag);
  if (existingAnimalPurchaseId && existingAnimalPurchaseId !== treatment.purchaseId) {
    const error = new Error(
      `Animal ${treatment.animalTag} is already linked to purchase batch #${existingAnimalPurchaseId}.`,
    );
    error.status = 409;
    throw error;
  }

  const result = db.prepare(`
    INSERT INTO treatments (
      treatment_date, purchase_id, animal_tag, treatment_description,
      medicine, dosage, veterinarian, treatment_cost, follow_up_date, notes
    ) VALUES (
      @treatmentDate, @purchaseId, @animalTag, @treatmentDescription,
      @medicine, @dosage, @veterinarian, @treatmentCost, @followUpDate, @notes
    )
  `).run(treatment);

  return db.prepare(`
    ${treatmentSelect}
    WHERE t.id = ?
  `).get(result.lastInsertRowid);
});

export function createTreatment(treatment) {
  return insertTreatment(treatment);
}

export function deleteTreatment(id) {
  const result = db.prepare('DELETE FROM treatments WHERE id = ?').run(id);
  return result.changes > 0;
}

export function listFeeds() {
  return db.prepare(`
    ${feedSelect}
    ORDER BY f.feed_date DESC, f.feed_time DESC, f.id DESC
  `).all();
}

const insertFeed = db.transaction((feed) => {
  const batch = getPurchase(feed.purchaseId);
  if (!batch) {
    const error = new Error('The selected purchase batch does not exist.');
    error.status = 404;
    throw error;
  }
  if (batch.availableQuantity <= 0) {
    const error = new Error('The selected purchase batch has no animals remaining in stock.');
    error.status = 409;
    throw error;
  }

  const existing = db.prepare(`
    SELECT id FROM feeds
    WHERE purchase_id = @purchaseId
      AND feed_date = @feedDate
      AND slot = @slot
    LIMIT 1
  `).get(feed);
  if (existing) {
    const error = new Error('Feed is already recorded for this batch, date, and meal slot.');
    error.status = 409;
    throw error;
  }

  let result;
  try {
    result = db.prepare(`
      INSERT INTO feeds (
        feed_date, feed_time, purchase_id, slot,
        basket_count, feed_description, notes
      ) VALUES (
        @feedDate, @feedTime, @purchaseId, @slot,
        @basketCount, @feedDescription, @notes
      )
    `).run(feed);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      error.message = 'Feed is already recorded for this batch, date, and meal slot.';
      error.status = 409;
    }
    throw error;
  }

  return db.prepare(`
    ${feedSelect}
    WHERE f.id = ?
  `).get(result.lastInsertRowid);
});

export function createFeed(feed) {
  return insertFeed(feed);
}

export function deleteFeed(id) {
  const result = db.prepare('DELETE FROM feeds WHERE id = ?').run(id);
  return result.changes > 0;
}

function getRoom(id) {
  return db.prepare(`
    SELECT
      r.id,
      r.name,
      r.capacity,
      r.description,
      r.created_at AS createdAt,
      COUNT(ra.id) AS occupancy,
      CASE WHEN r.capacity = 0 THEN 1 ELSE 0 END AS isUnlimited,
      CASE
        WHEN r.capacity = 0 THEN NULL
        WHEN r.capacity > COUNT(ra.id) THEN r.capacity - COUNT(ra.id)
        ELSE 0
      END AS availableCapacity
    FROM rooms r
    LEFT JOIN room_assignments ra ON ra.room_id = r.id
    WHERE r.id = ?
    GROUP BY r.id
  `).get(id);
}

export function listRooms() {
  return db.prepare(`
    SELECT
      r.id,
      r.name,
      r.capacity,
      r.description,
      r.created_at AS createdAt,
      COUNT(ra.id) AS occupancy,
      CASE WHEN r.capacity = 0 THEN 1 ELSE 0 END AS isUnlimited,
      CASE
        WHEN r.capacity = 0 THEN NULL
        WHEN r.capacity > COUNT(ra.id) THEN r.capacity - COUNT(ra.id)
        ELSE 0
      END AS availableCapacity
    FROM rooms r
    LEFT JOIN room_assignments ra ON ra.room_id = r.id
    GROUP BY r.id
    ORDER BY r.name COLLATE NOCASE ASC, r.id ASC
  `).all();
}

export function createRoom(room) {
  let result;
  try {
    result = db.prepare(`
      INSERT INTO rooms (name, capacity, description)
      VALUES (@name, @capacity, @description)
    `).run(room);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      error.message = 'A room with this name already exists.';
      error.status = 409;
    }
    throw error;
  }
  return getRoom(result.lastInsertRowid);
}

const updateRoomTransaction = db.transaction((id, room) => {
  const current = getRoom(id);
  if (!current) {
    const error = new Error('Room not found.');
    error.status = 404;
    throw error;
  }
  if (room.capacity !== 0 && room.capacity < current.occupancy) {
    const error = new Error(
      `Room capacity cannot be less than the current occupancy of ${current.occupancy}.`,
    );
    error.status = 409;
    throw error;
  }

  try {
    db.prepare(`
      UPDATE rooms
      SET name = @name, capacity = @capacity, description = @description
      WHERE id = @id
    `).run({ id, ...room });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      error.message = 'A room with this name already exists.';
      error.status = 409;
    }
    throw error;
  }
  return getRoom(id);
});

export function updateRoom(id, room) {
  return updateRoomTransaction(id, room);
}

export function deleteRoom(id) {
  const room = getRoom(id);
  if (!room) return { deleted: false, hasAssignments: false };
  if (room.occupancy > 0) return { deleted: false, hasAssignments: true };
  const result = db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
  return { deleted: result.changes > 0, hasAssignments: false };
}

function getRoomAssignment(id) {
  return db.prepare(`
    ${roomAssignmentSelect}
    WHERE ra.id = ?
  `).get(id);
}

export function listRoomAssignments() {
  return db.prepare(`
    ${roomAssignmentSelect}
    ORDER BY r.name COLLATE NOCASE ASC, ra.animal_tag COLLATE NOCASE ASC, ra.id ASC
  `).all();
}

const insertRoomAssignment = db.transaction((assignment) => {
  const room = getRoom(assignment.roomId);
  if (!room) {
    const error = new Error('The selected room does not exist.');
    error.status = 404;
    throw error;
  }
  if (!room.isUnlimited && room.availableCapacity <= 0) {
    const error = new Error(`${room.name} has reached its capacity.`);
    error.status = 409;
    throw error;
  }

  const batch = getPurchase(assignment.purchaseId);
  if (!batch) {
    const error = new Error('The selected purchase batch does not exist.');
    error.status = 404;
    throw error;
  }
  if (batch.availableQuantity <= 0) {
    const error = new Error('The selected purchase batch has no animals remaining in stock.');
    error.status = 409;
    throw error;
  }

  const existingAnimalPurchaseId = getAnimalPurchaseId(assignment.animalTag);
  if (existingAnimalPurchaseId && existingAnimalPurchaseId !== assignment.purchaseId) {
    const error = new Error(
      `Animal ${assignment.animalTag} is already linked to purchase batch #${existingAnimalPurchaseId}.`,
    );
    error.status = 409;
    throw error;
  }

  const existingAssignment = db.prepare(`
    SELECT ra.id, r.name AS roomName
    FROM room_assignments ra
    JOIN rooms r ON r.id = ra.room_id
    WHERE ra.animal_tag = ? COLLATE NOCASE
    LIMIT 1
  `).get(assignment.animalTag);
  if (existingAssignment) {
    const error = new Error(`${assignment.animalTag} is already assigned to ${existingAssignment.roomName}.`);
    error.status = 409;
    throw error;
  }

  const assignedToBatch = db.prepare(`
    SELECT COUNT(*) AS count
    FROM room_assignments
    WHERE purchase_id = ?
  `).get(assignment.purchaseId).count;
  if (assignedToBatch >= batch.availableQuantity) {
    const error = new Error('All available animals in this purchase batch are already assigned to rooms.');
    error.status = 409;
    throw error;
  }

  let result;
  try {
    result = db.prepare(`
      INSERT INTO room_assignments (room_id, purchase_id, animal_tag, notes)
      VALUES (@roomId, @purchaseId, @animalTag, @notes)
    `).run(assignment);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      error.message = `${assignment.animalTag} is already assigned to a room.`;
      error.status = 409;
    }
    throw error;
  }
  return getRoomAssignment(result.lastInsertRowid);
});

export function createRoomAssignment(assignment) {
  return insertRoomAssignment(assignment);
}

const updateRoomAssignment = db.transaction((id, roomId) => {
  const assignment = getRoomAssignment(id);
  if (!assignment) {
    const error = new Error('Room assignment not found.');
    error.status = 404;
    throw error;
  }
  const room = getRoom(roomId);
  if (!room) {
    const error = new Error('The selected room does not exist.');
    error.status = 404;
    throw error;
  }
  if (assignment.roomId === roomId) return assignment;
  if (!room.isUnlimited && room.availableCapacity <= 0) {
    const error = new Error(`${room.name} has reached its capacity.`);
    error.status = 409;
    throw error;
  }

  db.prepare(`
    UPDATE room_assignments
    SET room_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(roomId, id);
  return getRoomAssignment(id);
});

export function moveRoomAssignment(id, roomId) {
  return updateRoomAssignment(id, roomId);
}

export function deleteRoomAssignment(id) {
  const result = db.prepare('DELETE FROM room_assignments WHERE id = ?').run(id);
  return result.changes > 0;
}

const expenditureSelect = `
  SELECT
    id,
    expenditure_date AS expenditureDate,
    purpose,
    paid_to AS paidTo,
    amount,
    remarks,
    created_at AS createdAt
  FROM expenditures
`;

export function listExpenditures() {
  return db.prepare(`
    ${expenditureSelect}
    ORDER BY expenditure_date DESC, id DESC
  `).all();
}

export function createExpenditure(expenditure) {
  const result = db.prepare(`
    INSERT INTO expenditures (
      expenditure_date, purpose, paid_to, amount, remarks
    ) VALUES (
      @expenditureDate, @purpose, @paidTo, @amount, @remarks
    )
  `).run(expenditure);

  return db.prepare(`
    ${expenditureSelect}
    WHERE id = ?
  `).get(result.lastInsertRowid);
}

export function deleteExpenditure(id) {
  const result = db.prepare('DELETE FROM expenditures WHERE id = ?').run(id);
  return result.changes > 0;
}
