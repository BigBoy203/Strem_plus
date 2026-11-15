FFmpeg for the Strem+ helper
============================

The Strem+ helper uses these files to convert downloads (for example MKV to MP4) so Stremio can
play them smoothly. They are an unmodified copy of a standard FFmpeg build:

  Version:  FFmpeg n6.0-22-g549430e14d (2023-05-29), Windows, shared libraries, LGPL
  Build:    BtbN FFmpeg-Builds  https://github.com/BtbN/FFmpeg-Builds
  Source:   https://github.com/FFmpeg/FFmpeg/tree/549430e14d  (and https://ffmpeg.org)

FFmpeg is free software, licensed under the GNU Lesser General Public License version 3 or later
(see COPYING.LGPLv3.txt, which builds on COPYING.GPLv3.txt). It is not part of Strem+ and is not
covered by Strem+'s MIT license. FFmpeg is a trademark of Fabrice Bellard.

To use a different FFmpeg, replace ffmpeg.exe, ffprobe.exe and their DLLs in this folder.
