package com.colmhewson.crewbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

import java.util.Arrays;
import java.util.Collections;

import org.junit.Test;

/**
 * Reading the join poster's QR from a camera frame, as ScannerActivity hands
 * one over: a luminance plane with rows further apart than the picture is
 * wide, as phones' cameras deliver them.
 */
public class QrFrameReaderTest {

  /** What a box's poster encodes on the local network (/connect). */
  private static final String POSTER = "http://192.168.8.1/?pin=4821";

  private static final int WIDTH = 640;
  private static final int HEIGHT = 480;
  /** Wider than the picture: the camera pads each row. */
  private static final int STRIDE = 704;

  /** A grey frame with the code drawn into it, `scale` pixels to a module. */
  private static byte[] frame(String text, int scale, boolean lightOnDark) throws WriterException {
    BitMatrix code = new QRCodeWriter()
        .encode(text, BarcodeFormat.QR_CODE, 0, 0,
            Collections.singletonMap(EncodeHintType.MARGIN, 4));
    byte[] frame = new byte[STRIDE * HEIGHT];
    // Padding holds whatever the camera left there, never the picture.
    Arrays.fill(frame, (byte) 0x55);
    int size = code.getWidth() * scale;
    int left = (WIDTH - size) / 2;
    int top = (HEIGHT - size) / 2;
    for (int y = 0; y < HEIGHT; y++) {
      for (int x = 0; x < WIDTH; x++) {
        boolean inCode = x >= left && x < left + size && y >= top && y < top + size;
        boolean module = inCode && code.get((x - left) / scale, (y - top) / scale);
        boolean dark = lightOnDark ? !module : module;
        frame[y * STRIDE + x] = (byte) (dark ? 0x20 : 0xE0);
      }
    }
    return frame;
  }

  @Test
  public void readsTheJoinPoster() throws WriterException {
    assertEquals(POSTER, new QrFrameReader().read(frame(POSTER, 5, false), STRIDE, WIDTH, HEIGHT));
  }

  @Test
  public void readsItLightOnDark() throws WriterException {
    // As a box's console draws it on a terminal with dark text on light: the
    // code is drawn in the text colour, so there it comes out inverted.
    assertEquals(POSTER, new QrFrameReader().read(frame(POSTER, 5, true), STRIDE, WIDTH, HEIGHT));
  }

  @Test
  public void readsAFrameWhoseLastRowIsNotPadded() throws WriterException {
    byte[] full = frame(POSTER, 5, false);
    byte[] trimmed = Arrays.copyOf(full, STRIDE * (HEIGHT - 1) + WIDTH);
    assertEquals(POSTER, new QrFrameReader().read(trimmed, STRIDE, WIDTH, HEIGHT));
  }

  @Test
  public void findsNothingInAFrameWithoutACode() {
    byte[] blank = new byte[STRIDE * HEIGHT];
    Arrays.fill(blank, (byte) 0x80);
    assertNull(new QrFrameReader().read(blank, STRIDE, WIDTH, HEIGHT));
  }

  @Test
  public void refusesAFrameSmallerThanItsSize() throws WriterException {
    byte[] full = frame(POSTER, 5, false);
    byte[] short_ = Arrays.copyOf(full, STRIDE * (HEIGHT - 1));
    assertNull(new QrFrameReader().read(short_, STRIDE, WIDTH, HEIGHT));
    assertNull(new QrFrameReader().read(full, WIDTH - 1, WIDTH, HEIGHT));
  }

  @Test
  public void readsOneFrameAfterAnother() throws WriterException {
    // One reader for the whole scan, as the camera's analyzer uses it.
    QrFrameReader reader = new QrFrameReader();
    byte[] blank = new byte[STRIDE * HEIGHT];
    assertNull(reader.read(blank, STRIDE, WIDTH, HEIGHT));
    assertEquals(POSTER, reader.read(frame(POSTER, 5, false), STRIDE, WIDTH, HEIGHT));
    assertEquals("WIFI:T:WPA;S:Crew;P:x;;",
        reader.read(frame("WIFI:T:WPA;S:Crew;P:x;;", 5, false), STRIDE, WIDTH, HEIGHT));
  }
}
