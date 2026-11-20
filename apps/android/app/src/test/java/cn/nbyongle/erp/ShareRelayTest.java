package cn.nbyongle.erp;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/** 一批分享交给网页：清单和每份怎么发、外壳自己数到头收尾、网页回绝、重连从头来、没开始的可替换 */
public class ShareRelayTest {
    private static final List<ShareRelay.Received> TWO = List.of(
            new ShareRelay.Received("a.pdf", "application/pdf", 3, new File("0.pdf")),
            new ShareRelay.Received("b.jpg", "image/jpeg", 4, new File("1.jpg")));

    private final List<String> sent = new ArrayList<>();
    private final List<ShareRelay.Ticket> loads = new ArrayList<>();
    private final List<ShareRelay.Result> results = new ArrayList<>();
    private final ShareRelay relay = new ShareRelay((ticket, file) -> loads.add(ticket), results::add);

    /** 接通、开始一批、网页回 share-ready */
    private void startTwo() {
        relay.connected(sent::add);
        relay.start("s-1", TWO);
        relay.ready("s-1");
    }

    /** 最后一次要读的那份读好了 */
    private ShareRelay.Ticket loadLast() {
        ShareRelay.Ticket ticket = loads.get(loads.size() - 1);
        relay.loaded(ticket, ShareRelay.fileMessage(ticket.shareId, ticket.index, "QUJD"));
        return ticket;
    }

    private String lastSent() {
        return sent.get(sent.size() - 1);
    }

    @Test
    public void offerListsFilesWithoutContent() {
        List<ShareRelay.Received> files = List.of(
                new ShareRelay.Received("订单\"A\".pdf", "application/pdf", 1234, new File("x")),
                new ShareRelay.Received("b.jpg", "image/jpeg", 5, new File("y")));
        assertEquals(
                "{\"type\":\"share-offer\",\"shareId\":\"s-1\",\"files\":["
                        + "{\"name\":\"订单\\\"A\\\".pdf\",\"mime\":\"application/pdf\",\"size\":1234},"
                        + "{\"name\":\"b.jpg\",\"mime\":\"image/jpeg\",\"size\":5}]}",
                ShareRelay.offerMessage("s-1", files));
    }

    @Test
    public void quoteEscapesQuotesBackslashesAndControlCharacters() {
        assertEquals("\"a\\\\b\\\"c\\u000ad\"", ShareRelay.quote("a\\b\"c\nd"));
    }

    @Test
    public void batchWaitsForTheBridgeThenOffers() {
        relay.start("s-1", TWO);
        assertTrue(sent.isEmpty());
        relay.connected(sent::add);
        assertEquals(ShareRelay.offerMessage("s-1", TWO), lastSent());
    }

    @Test
    public void readyLoadsTheFirstFileAndSendsItOnceLoaded() {
        startTwo();
        assertEquals(0, loads.get(0).index);
        loadLast();
        assertEquals("{\"type\":\"share-file\",\"shareId\":\"s-1\",\"index\":0,\"data\":\"QUJD\"}", lastSent());
    }

    @Test
    public void eachResultMovesOnAndTheLastOneFinishesTheBatch() {
        startTwo();
        loadLast();
        relay.uploaded("s-1", 0, true);
        assertEquals(1, loads.get(1).index);
        loadLast();
        relay.failed("s-1", 1, "超过上限");
        assertEquals(1, results.size());
        assertEquals(1, results.get(0).uploaded);
        assertEquals(1, results.get(0).duplicate);
        assertEquals(List.of("超过上限"), results.get(0).failures);
        assertNull(results.get(0).rejected);
        assertFalse(relay.busy());
    }

    @Test
    public void unreadableFileIsCountedAndSkipped() {
        startTwo();
        relay.unreadable(loads.get(0), "a.pdf 读不出来");
        assertEquals(1, loads.get(1).index);
        relay.unreadable(loads.get(1), "b.jpg 读不出来");
        assertEquals(List.of("a.pdf 读不出来", "b.jpg 读不出来"), results.get(0).failures);
    }

    @Test
    public void answersForOtherBatchesOtherIndexesOrUnsentFilesAreIgnored() {
        startTwo();
        relay.uploaded("s-1", 0, false);
        loadLast();
        relay.uploaded("s-2", 0, false);
        relay.uploaded("s-1", 1, false);
        assertEquals(1, loads.size());
        assertTrue(results.isEmpty());
    }

    @Test
    public void reconnectingStartsOverFromTheOffer() {
        startTwo();
        loadLast();
        relay.uploaded("s-1", 0, false);
        relay.connected(sent::add);
        assertEquals(ShareRelay.offerMessage("s-1", TWO), lastSent());
        assertFalse(relay.busy());
        relay.ready("s-1");
        assertEquals(0, loads.get(loads.size() - 1).index);
    }

    @Test
    public void filesLoadedBeforeAReconnectAreDropped() {
        startTwo();
        relay.disconnected();
        relay.connected(sent::add);
        int before = sent.size();
        relay.loaded(loads.get(0), "旧的");
        assertEquals(before, sent.size());
    }

    @Test
    public void rejectedBatchFinishesWithThePagesReason() {
        relay.connected(sent::add);
        relay.start("s-1", TWO);
        relay.rejected("s-1", "这个账号不能使用 AI 导入");
        assertEquals("这个账号不能使用 AI 导入", results.get(0).rejected);
        assertEquals("s-1", results.get(0).shareId);
    }

    @Test
    public void batchNotStartedYetIsReplacedByANewShare() {
        relay.connected(sent::add);
        relay.start("s-1", TWO);
        assertEquals("s-1", relay.start("s-2", TWO));
        assertEquals(ShareRelay.offerMessage("s-2", TWO), lastSent());
        relay.ready("s-1");
        assertTrue(loads.isEmpty());
    }

    @Test
    public void batchBeingSentIsBusy() {
        startTwo();
        assertTrue(relay.busy());
        assertThrows(IllegalStateException.class, () -> relay.start("s-2", TWO));
    }

    @Test
    public void losingTheBridgeMakesTheBatchReplaceableAgain() {
        startTwo();
        relay.disconnected();
        assertFalse(relay.busy());
    }
}
