-- Create the database and the application account.
--
-- Run it once as a MySQL administrator:
--
--   mysql -u root -p < scripts/create-database.sql
--
-- Then put the same credentials in `.env`:
--
--   DB_HOST=127.0.0.1
--   DB_PORT=3306
--   DB_USER=dam
--   DB_PASSWORD=<the password you chose here>
--   DB_NAME=digital_management
--
-- The application creates the schema, the tables and the seed rows itself,
-- so this script only has to hand out the database and the account.

CREATE DATABASE IF NOT EXISTS digital_management
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

-- The account needs CREATE on the schema (the server creates the tables)
-- and on the server itself (it creates the schema when it is missing).
-- Both 'localhost' and '127.0.0.1' are granted: with `skip_name_resolve=ON`
-- the server matches the literal address instead of the resolved name.
GRANT ALL PRIVILEGES ON digital_management.* TO 'dam'@'localhost' IDENTIFIED BY 'change-me';
GRANT ALL PRIVILEGES ON digital_management.* TO 'dam'@'127.0.0.1' IDENTIFIED BY 'change-me';
GRANT CREATE ON *.* TO 'dam'@'localhost';
GRANT CREATE ON *.* TO 'dam'@'127.0.0.1';

FLUSH PRIVILEGES;
