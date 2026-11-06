"""The collector's pure parts (no R2): timeline placement and frame parsing."""
import struct
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "collector"))
import collect  # noqa: E402


class Collect(unittest.TestCase):
    def test_pieces_land_at_their_time_with_silence_between(self):
        one = np.full(4800, 7, dtype="<i2").tobytes()  # 0.1 s
        out = collect.place([(1500.0, one), (1000.0, one)], 1000.0, 2000.0)
        self.assertEqual(len(out), 48000)
        self.assertTrue((out[:4800] == 7).all() and (out[4800:24000] == 0).all() and (out[24000:28800] == 7).all())

    def test_overlaps_are_mixed(self):
        a = np.full(4800, 1000, dtype="<i2").tobytes()
        out = collect.place([(1000.0, a), (1050.0, a)], 1000.0, 1200.0)
        self.assertEqual((out[0], out[2400]), (1000, 2000))

    def test_frames_are_read_back(self):
        blob = b"".join(struct.pack("<dI", ms, len(j)) + j for ms, j in [(1.5, b"\xff\xd8a"), (2.5, b"\xff\xd8bc")])
        self.assertEqual(list(collect.frames_of(blob)), [(1.5, b"\xff\xd8a"), (2.5, b"\xff\xd8bc")])

    def test_names_are_safe_file_names(self):
        self.assertEqual(collect.safe("Ann / Lee"), "Ann_Lee")
        self.assertEqual(collect.safe("../.."), "guest")  # no way out of the folder
        self.assertEqual(collect.safe("  "), "guest")


if __name__ == "__main__":
    unittest.main()
