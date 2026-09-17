-- 0035: forced-rollback flag travels WITH the bundle.
--
-- The device's OTA guard (tiny_ota.cpp, 0.14.9) refuses a pointer that is not
-- newer than the running firmware unless the bundle itself carries force. The
-- publish route's guard (check 17) used force only as a gate and dropped it —
-- so an intentional forced rollback passed publish and was then refused by
-- every device on the channel. Two correct guards, deadlocked. The flag is
-- channel STATE, not a request parameter: store it, serve it, and clear it
-- automatically on the next normal (forward) publish.
ALTER TABLE firmware_channels ADD COLUMN force_flag INTEGER NOT NULL DEFAULT 0;
