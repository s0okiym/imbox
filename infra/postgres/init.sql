-- Local development/test bootstrap. Production roles are provisioned separately.
CREATE ROLE imbox_app LOGIN PASSWORD 'imbox_local_app' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE imbox_identity LOGIN PASSWORD 'imbox_local_identity' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE imbox_test OWNER imbox_owner;
GRANT CONNECT ON DATABASE imbox_dev, imbox_test TO imbox_app, imbox_identity;

\connect imbox_dev
GRANT USAGE ON SCHEMA public TO imbox_app, imbox_identity;

\connect imbox_test
GRANT USAGE ON SCHEMA public TO imbox_app, imbox_identity;
-- Table privileges are explicitly assigned by the development bootstrap after migration.
